/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var EXPORTED_SYMBOLS = ["ContentSessionStore"];

ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm", this);
ChromeUtils.import("resource://gre/modules/Timer.jsm", this);
ChromeUtils.import("resource://gre/modules/Services.jsm", this);

function debug(msg) {
  Services.console.logStringMessage("SessionStoreContent: " + msg);
}

ChromeUtils.defineModuleGetter(
  this,
  "ContentRestore",
  "resource:///modules/sessionstore/ContentRestore.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "SessionHistoryListener",
  "resource:///modules/sessionstore/SessionHistoryListener.jsm"
);

// This pref controls whether or not we send updates to the parent on a timeout
// or not, and should only be used for tests or debugging.
const TIMEOUT_DISABLED_PREF = "browser.sessionstore.debug.no_auto_updates";

const PREF_INTERVAL = "browser.sessionstore.interval";

class Handler {
  constructor(store) {
    this.store = store;
  }

  get contentRestore() {
    return this.store.contentRestore;
  }

  get contentRestoreInitialized() {
    return this.store.contentRestoreInitialized;
  }

  get mm() {
    return this.store.mm;
  }

  get messageQueue() {
    return this.store.messageQueue;
  }
}

/**
 * Listens for and handles content events that we need for the
 * session store service to be notified of state changes in content.
 */
class EventListener extends Handler {
  constructor(store) {
    super(store);

    SessionStoreUtils.addDynamicFrameFilteredListener(
      this.mm,
      "load",
      this,
      true
    );
  }

  handleEvent(event) {
    let { content } = this.mm;

    // Ignore load events from subframes.
    if (event.target != content.document) {
      return;
    }

    if (content.document.documentURI.startsWith("about:reader")) {
      if (
        event.type == "load" &&
        !content.document.body.classList.contains("loaded")
      ) {
        // Don't restore the scroll position of an about:reader page at this
        // point; listen for the custom event dispatched from AboutReader.jsm.
        content.addEventListener("AboutReaderContentReady", this);
        return;
      }

      content.removeEventListener("AboutReaderContentReady", this);
    }

    if (this.contentRestoreInitialized) {
      // Restore the form data and scroll position. If we're not currently
      // restoring a tab state then this call will simply be a noop.
      this.contentRestore.restoreDocument();
    }
  }
}

/**
 * A message queue that takes collected data and will take care of sending it
 * to the chrome process. It allows flushing using synchronous messages and
 * takes care of any race conditions that might occur because of that. Changes
 * will be batched if they're pushed in quick succession to avoid a message
 * flood.
 */
class MessageQueue extends Handler {
  constructor(store) {
    super(store);

    /**
     * A map (string -> lazy fn) holding lazy closures of all queued data
     * collection routines. These functions will return data collected from the
     * docShell.
     */
    this._data = new Map();

    /**
     * The delay (in ms) used to delay sending changes after data has been
     * invalidated.
     */
    this.BATCH_DELAY_MS = 1000;

    /**
     * The minimum idle period (in ms) we need for sending data to chrome process.
     */
    this.NEEDED_IDLE_PERIOD_MS = 5;

    /**
     * Timeout for waiting an idle period to send data. We will set this from
     * the pref "browser.sessionstore.interval".
     */
    this._timeoutWaitIdlePeriodMs = null;

    /**
     * The current timeout ID, null if there is no queue data. We use timeouts
     * to damp a flood of data changes and send lots of changes as one batch.
     */
    this._timeout = null;

    /**
     * Whether or not sending batched messages on a timer is disabled. This should
     * only be used for debugging or testing. If you need to access this value,
     * you should probably use the timeoutDisabled getter.
     */
    this._timeoutDisabled = false;

    /**
     * True if there is already a send pending idle dispatch, set to prevent
     * scheduling more than one. If false there may or may not be one scheduled.
     */
    this._idleScheduled = false;

    this.timeoutDisabled = Services.prefs.getBoolPref(TIMEOUT_DISABLED_PREF);
    this._timeoutWaitIdlePeriodMs = Services.prefs.getIntPref(PREF_INTERVAL);

    Services.prefs.addObserver(TIMEOUT_DISABLED_PREF, this);
    Services.prefs.addObserver(PREF_INTERVAL, this);
  }

  /**
   * True if batched messages are not being fired on a timer. This should only
   * ever be true when debugging or during tests.
   */
  get timeoutDisabled() {
    return this._timeoutDisabled;
  }

  /**
   * Disables sending batched messages on a timer. Also cancels any pending
   * timers.
   */
  set timeoutDisabled(val) {
    this._timeoutDisabled = val;

    if (val && this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }

    return val;
  }

  uninit() {
    Services.prefs.removeObserver(TIMEOUT_DISABLED_PREF, this);
    Services.prefs.removeObserver(PREF_INTERVAL, this);
    this.cleanupTimers();
  }

  /**
   * Cleanup pending idle callback and timer.
   */
  cleanupTimers() {
    this._idleScheduled = false;
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }
  }

  observe(subject, topic, data) {
    if (topic == "nsPref:changed") {
      switch (data) {
        case TIMEOUT_DISABLED_PREF:
          this.timeoutDisabled = Services.prefs.getBoolPref(
            TIMEOUT_DISABLED_PREF
          );
          break;
        case PREF_INTERVAL:
          this._timeoutWaitIdlePeriodMs = Services.prefs.getIntPref(
            PREF_INTERVAL
          );
          break;
        default:
          debug("received unknown message '" + data + "'");
          break;
      }
    }
  }

  /**
   * Pushes a given |value| onto the queue. The given |key| represents the type
   * of data that is stored and can override data that has been queued before
   * but has not been sent to the parent process, yet.
   *
   * @param key (string)
   *        A unique identifier specific to the type of data this is passed.
   * @param fn (function)
   *        A function that returns the value that will be sent to the parent
   *        process.
   */
  push(key, fn) {
    this._data.set(key, fn);

    if (!this._timeout && !this._timeoutDisabled) {
      // Wait a little before sending the message to batch multiple changes.
      this._timeout = setTimeoutWithTarget(
        () => this.sendWhenIdle(),
        this.BATCH_DELAY_MS,
        this.mm.tabEventTarget
      );
    }
  }

  /**
   * Sends queued data when the remaining idle time is enough or waiting too
   * long; otherwise, request an idle time again. If the |deadline| is not
   * given, this function is going to schedule the first request.
   *
   * @param deadline (object)
   *        An IdleDeadline object passed by idleDispatch().
   */
  sendWhenIdle(deadline) {
    if (!this.mm.content) {
      // The frameloader is being torn down. Nothing more to do.
      return;
    }

    if (deadline) {
      if (
        deadline.didTimeout ||
        deadline.timeRemaining() > this.NEEDED_IDLE_PERIOD_MS
      ) {
        this.send();
        return;
      }
    } else if (this._idleScheduled) {
      // Bail out if there's a pending run.
      return;
    }
    ChromeUtils.idleDispatch(deadline_ => this.sendWhenIdle(deadline_), {
      timeout: this._timeoutWaitIdlePeriodMs,
    });
    this._idleScheduled = true;
  }

  /**
   * Sends queued data to the chrome process.
   *
   * @param options (object)
   *        {flushID: 123} to specify that this is a flush
   *        {isFinal: true} to signal this is the final message sent on unload
   */
  send(options = {}) {
    // Looks like we have been called off a timeout after the tab has been
    // closed. The docShell is gone now and we can just return here as there
    // is nothing to do.
    if (!this.mm.docShell) {
      return;
    }

    this.cleanupTimers();

    let flushID = (options && options.flushID) || 0;
    let histID = "FX_SESSION_RESTORE_CONTENT_COLLECT_DATA_MS";

    let data = {};
    for (let [key, func] of this._data) {
      if (key != "isPrivate") {
        TelemetryStopwatch.startKeyed(histID, key);
      }

      let value = func();

      if (key != "isPrivate") {
        TelemetryStopwatch.finishKeyed(histID, key);
      }

      if (value || (key != "storagechange" && key != "historychange")) {
        data[key] = value;
      }
    }

    this._data.clear();

    try {
      // Send all data to the parent process.
      this.mm.sendAsyncMessage("SessionStore:update", {
        data,
        flushID,
        isFinal: options.isFinal || false,
        epoch: this.store.epoch,
      });
    } catch (ex) {
      if (ex && ex.result == Cr.NS_ERROR_OUT_OF_MEMORY) {
        Services.telemetry
          .getHistogramById("FX_SESSION_RESTORE_SEND_UPDATE_CAUSED_OOM")
          .add(1);
        this.mm.sendAsyncMessage("SessionStore:error");
      }
    }
  }
}

/**
 * Listens for and handles messages sent by the session store service.
 */
const MESSAGES = [
  "SessionStore:restoreHistory",
  "SessionStore:finishRestoreHistory",
  "SessionStore:OnHistoryReload",
  "SessionStore:OnHistoryNewEntry",
  "SessionStore:restoreTabContent",
  "SessionStore:resetRestore",
  "SessionStore:flush",
  "SessionStore:becomeActiveProcess",
];

class ContentSessionStore {
  constructor(mm) {
    this.mm = mm;
    this.messageQueue = new MessageQueue(this);

    this.epoch = 0;

    this.contentRestoreInitialized = false;

    this.waitRestoreSHistoryInParent = false;
    this.restoreTabContentData = null;

    XPCOMUtils.defineLazyGetter(this, "contentRestore", () => {
      this.contentRestoreInitialized = true;
      return new ContentRestore(mm);
    });

    this.handlers = [new EventListener(this), this.messageQueue];

    this._shistoryInParent = Services.prefs.getBoolPref(
      "fission.sessionHistoryInParent",
      false
    );
    if (this._shistoryInParent) {
      this.mm.sendAsyncMessage("SessionStore:addSHistoryListener");
    } else {
      this.handlers.push(new SessionHistoryListener(this));
    }

    MESSAGES.forEach(m => mm.addMessageListener(m, this));

    // If we're browsing from the tab crashed UI to a blacklisted URI that keeps
    // this browser non-remote, we'll handle that in a pagehide event.
    mm.addEventListener("pagehide", this);
    mm.addEventListener("unload", this);
  }

  receiveMessage({ name, data }) {
    // The docShell might be gone. Don't process messages,
    // that will just lead to errors anyway.
    if (!this.mm.docShell) {
      return;
    }

    // A fresh tab always starts with epoch=0. The parent has the ability to
    // override that to signal a new era in this tab's life. This enables it
    // to ignore async messages that were already sent but not yet received
    // and would otherwise confuse the internal tab state.
    if (data && data.epoch && data.epoch != this.epoch) {
      this.epoch = data.epoch;
    }

    switch (name) {
      case "SessionStore:restoreHistory":
        this.restoreHistory(data);
        break;
      case "SessionStore:finishRestoreHistory":
        this.finishRestoreHistory();
        break;
      case "SessionStore:OnHistoryNewEntry":
        this.contentRestore.restoreOnNewEntry(data.uri);
        break;
      case "SessionStore:OnHistoryReload":
        // On reload, restore tab contents.
        this.contentRestore.restoreTabContent(
          null,
          false,
          () => {
            // Tell SessionStore.jsm that it may want to restore some more tabs,
            // since it restores a max of MAX_CONCURRENT_TAB_RESTORES at a time.
            this.mm.sendAsyncMessage("SessionStore:restoreTabContentComplete", {
              epoch: this.epoch,
            });
          },
          () => {
            // Tell SessionStore.jsm to remove restoreListener.
            this.mm.sendAsyncMessage("SessionStore:removeRestoreListener", {
              epoch: this.epoch,
            });
          },
          () => {
            // Tell SessionStore.jsm to reload currentEntry.
            this.mm.sendAsyncMessage("SessionStore:reloadCurrentEntry", {
              epoch: this.epoch,
            });
          }
        );
        break;
      case "SessionStore:restoreTabContent":
        if (this.waitRestoreSHistoryInParent) {
          // Queue the TabContentData if we haven't finished sHistoryRestore yet.
          this.restoreTabContentData = data;
        } else {
          this.restoreTabContent(data);
        }
        break;
      case "SessionStore:resetRestore":
        this.contentRestore.resetRestore();
        break;
      case "SessionStore:flush":
        this.flush(data);
        break;
      case "SessionStore:becomeActiveProcess":
        if (!this._shistoryInParent) {
          SessionHistoryListener.collect();
        }
        break;
      default:
        debug("received unknown message '" + name + "'");
        break;
    }
  }

  restoreHistory({ epoch, tabData, loadArguments, isRemotenessUpdate }) {
    this.contentRestore.restoreHistory(
      tabData,
      loadArguments,
      {
        // Note: The callbacks passed here will only be used when a load starts
        // that was not initiated by sessionstore itself. This can happen when
        // some code calls browser.loadURI() or browser.reload() on a pending
        // browser/tab.

        onLoadStarted: () => {
          // Notify the parent that the tab is no longer pending.
          this.mm.sendAsyncMessage("SessionStore:restoreTabContentStarted", {
            epoch,
          });
        },

        onLoadFinished: () => {
          // Tell SessionStore.jsm that it may want to restore some more tabs,
          // since it restores a max of MAX_CONCURRENT_TAB_RESTORES at a time.
          this.mm.sendAsyncMessage("SessionStore:restoreTabContentComplete", {
            epoch,
          });
        },

        removeRestoreListener: () => {
          if (!this._shistoryInParent) {
            return;
          }

          // Notify the parent that the tab is no longer pending.
          this.mm.sendAsyncMessage("SessionStore:removeRestoreListener", {
            epoch,
          });
        },

        requestRestoreSHistory: () => {
          if (!this._shistoryInParent) {
            return;
          }

          this.waitRestoreSHistoryInParent = true;
          // Send tabData to the parent process.
          this.mm.sendAsyncMessage("SessionStore:restoreSHistoryInParent", {
            epoch,
          });
        },
      },
      this._shistoryInParent
    );

    if (Services.appinfo.processType == Services.appinfo.PROCESS_TYPE_DEFAULT) {
      // For non-remote tabs, when restoreHistory finishes, we send a synchronous
      // message to SessionStore.jsm so that it can run SSTabRestoring. Users of
      // SSTabRestoring seem to get confused if chrome and content are out of
      // sync about the state of the restore (particularly regarding
      // docShell.currentURI). Using a synchronous message is the easiest way
      // to temporarily synchronize them.
      //
      // For remote tabs, because all nsIWebProgress notifications are sent
      // asynchronously using messages, we get the same-order guarantees of the
      // message manager, and can use an async message.
      this.mm.sendSyncMessage("SessionStore:restoreHistoryComplete", {
        epoch,
        isRemotenessUpdate,
      });
    } else if (!this._shistoryInParent) {
      this.mm.sendAsyncMessage("SessionStore:restoreHistoryComplete", {
        epoch,
        isRemotenessUpdate,
      });
    }
  }

  finishRestoreHistory() {
    this.contentRestore.finishRestoreHistory({
      // Note: The callbacks passed here will only be used when a load starts
      // that was not initiated by sessionstore itself. This can happen when
      // some code calls browser.loadURI() or browser.reload() on a pending
      // browser/tab.
      onLoadStarted: () => {
        // Notify the parent that the tab is no longer pending.
        this.mm.sendAsyncMessage("SessionStore:restoreTabContentStarted", {
          epoch: this.epoch,
        });
      },

      onLoadFinished: () => {
        // Tell SessionStore.jsm that it may want to restore some more tabs,
        // since it restores a max of MAX_CONCURRENT_TAB_RESTORES at a time.
        this.mm.sendAsyncMessage("SessionStore:restoreTabContentComplete", {
          epoch: this.epoch,
        });
      },

      removeRestoreListener: () => {
        if (!this._shistoryInParent) {
          return;
        }

        // Notify the parent that the tab is no longer pending.
        this.mm.sendAsyncMessage("SessionStore:removeRestoreListener", {
          epoch: this.epoch,
        });
      },
    });

    this.mm.sendAsyncMessage("SessionStore:restoreHistoryComplete", {
      epoch: this.epoch,
    });
    if (this.restoreTabContentData) {
      this.restoreTabContent(this.restoreTabContentData);
      this.restoreTabContentData = null;
    }
    this.waitRestoreSHistoryInParent = false;
  }

  restoreTabContent({ loadArguments, isRemotenessUpdate, reason }) {
    let epoch = this.epoch;

    // We need to pass the value of didStartLoad back to SessionStore.jsm.
    let didStartLoad = this.contentRestore.restoreTabContent(
      loadArguments,
      isRemotenessUpdate,
      () => {
        // Tell SessionStore.jsm that it may want to restore some more tabs,
        // since it restores a max of MAX_CONCURRENT_TAB_RESTORES at a time.
        this.mm.sendAsyncMessage("SessionStore:restoreTabContentComplete", {
          epoch,
          isRemotenessUpdate,
        });
      },
      () => {
        // Tell SessionStore.jsm to remove restore listener.
        this.mm.sendAsyncMessage("SessionStore:removeRestoreListener", {
          epoch,
        });
      },
      () => {
        this.mm.sendAsyncMessage("SessionStore:reloadCurrentEntry", {
          epoch,
        });
      }
    );

    this.mm.sendAsyncMessage("SessionStore:restoreTabContentStarted", {
      epoch,
      isRemotenessUpdate,
      reason,
    });

    if (!didStartLoad) {
      // Pretend that the load succeeded so that event handlers fire correctly.
      this.mm.sendAsyncMessage("SessionStore:restoreTabContentComplete", {
        epoch,
        isRemotenessUpdate,
      });
    }
  }

  flush({ id }) {
    // Flush the message queue, send the latest updates.
    this.messageQueue.send({ flushID: id });
  }

  handleEvent(event) {
    if (event.type == "pagehide") {
      this.handleRevivedTab();
    } else if (event.type == "unload") {
      this.onUnload();
    }
  }

  onUnload() {
    // Upon frameLoader destruction, send a final update message to
    // the parent and flush all data currently held in the child.
    this.messageQueue.send({ isFinal: true });

    // If we're browsing from the tab crashed UI to a URI that causes the tab
    // to go remote again, we catch this in the unload event handler, because
    // swapping out the non-remote browser for a remote one in
    // tabbrowser.xml's updateBrowserRemoteness doesn't cause the pagehide
    // event to be fired.
    this.handleRevivedTab();

    for (let handler of this.handlers) {
      if (handler.uninit) {
        handler.uninit();
      }
    }

    if (this.contentRestoreInitialized) {
      // Remove progress listeners.
      this.contentRestore.resetRestore();
    }

    // We don't need to take care of any StateChangeNotifier observers as they
    // will die with the content script. The same goes for the privacy transition
    // observer that will die with the docShell when the tab is closed.
  }

  handleRevivedTab() {
    let { content } = this.mm;

    if (!content) {
      this.mm.removeEventListener("pagehide", this);
      return;
    }

    if (content.document.documentURI.startsWith("about:tabcrashed")) {
      if (
        Services.appinfo.processType != Services.appinfo.PROCESS_TYPE_DEFAULT
      ) {
        // Sanity check - we'd better be loading this in a non-remote browser.
        throw new Error(
          "We seem to be navigating away from about:tabcrashed in " +
            "a non-remote browser. This should really never happen."
        );
      }

      this.mm.removeEventListener("pagehide", this);

      // Notify the parent.
      this.mm.sendAsyncMessage("SessionStore:crashedTabRevived");
    }
  }
}

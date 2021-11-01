/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {SimpleChannel} = ChromeUtils.import('chrome://juggler/content/SimpleChannel.js');
const {EventEmitter} = ChromeUtils.import('resource://gre/modules/EventEmitter.jsm');
const {Runtime} = ChromeUtils.import('chrome://juggler/content/content/Runtime.js');

const helper = new Helper();

class FrameTree {
  constructor(rootDocShell) {
    EventEmitter.decorate(this);

    this._browsingContextGroup = rootDocShell.browsingContext.group;
    if (!this._browsingContextGroup.__jugglerFrameTrees)
      this._browsingContextGroup.__jugglerFrameTrees = new Set();
    this._browsingContextGroup.__jugglerFrameTrees.add(this);
    this._isolatedWorlds = new Map();

    this._webSocketEventService = Cc[
      "@mozilla.org/websocketevent/service;1"
    ].getService(Ci.nsIWebSocketEventService);

    this._runtime = new Runtime(false /* isWorker */);
    this._workers = new Map();
    this._docShellToFrame = new Map();
    this._frameIdToFrame = new Map();
    this._pageReady = false;
    this._mainFrame = this._createFrame(rootDocShell);
    const webProgress = rootDocShell.QueryInterface(Ci.nsIInterfaceRequestor)
                                .getInterface(Ci.nsIWebProgress);
    this.QueryInterface = ChromeUtils.generateQI([
      Ci.nsIWebProgressListener,
      Ci.nsIWebProgressListener2,
      Ci.nsISupportsWeakReference,
    ]);

    this._addedScrollbarsStylesheetSymbol = Symbol('_addedScrollbarsStylesheetSymbol');

    this._wdm = Cc["@mozilla.org/dom/workers/workerdebuggermanager;1"].createInstance(Ci.nsIWorkerDebuggerManager);
    this._wdmListener = {
      QueryInterface: ChromeUtils.generateQI([Ci.nsIWorkerDebuggerManagerListener]),
      onRegister: this._onWorkerCreated.bind(this),
      onUnregister: this._onWorkerDestroyed.bind(this),
    };
    this._wdm.addListener(this._wdmListener);
    for (const workerDebugger of this._wdm.getWorkerDebuggerEnumerator())
      this._onWorkerCreated(workerDebugger);

    const flags = Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT |
                  Ci.nsIWebProgress.NOTIFY_LOCATION;
    this._eventListeners = [
      helper.addObserver(this._onDOMWindowCreated.bind(this), 'content-document-global-created'),
      helper.addObserver(this._onDOMWindowCreated.bind(this), 'juggler-dom-window-reused'),
      helper.addObserver(subject => this._onDocShellCreated(subject.QueryInterface(Ci.nsIDocShell)), 'webnavigation-create'),
      helper.addObserver(subject => this._onDocShellDestroyed(subject.QueryInterface(Ci.nsIDocShell)), 'webnavigation-destroy'),
      helper.addProgressListener(webProgress, this, flags),
    ];
  }

  workers() {
    return [...this._workers.values()];
  }

  runtime() {
    return this._runtime;
  }

  addScriptToEvaluateOnNewDocument(script, worldName) {
    worldName = worldName || '';
    const existing = this._isolatedWorlds.has(worldName);
    const world = this._ensureWorld(worldName);
    world._scriptsToEvaluateOnNewDocument.push(script);
    // FIXME: 'should inherit http credentials from browser context' fails without this
    if (worldName && !existing) {
      for (const frame of this.frames())
        frame._createIsolatedContext(worldName);
    }
  }

  _ensureWorld(worldName) {
    worldName = worldName || '';
    let world = this._isolatedWorlds.get(worldName);
    if (!world) {
      world = new IsolatedWorld(worldName);
      this._isolatedWorlds.set(worldName, world);
    }
    return world;
  }

  _frameForWorker(workerDebugger) {
    if (workerDebugger.type !== Ci.nsIWorkerDebugger.TYPE_DEDICATED)
      return null;
    if (!workerDebugger.window)
      return null;
    const docShell = workerDebugger.window.docShell;
    return this._docShellToFrame.get(docShell) || null;
  }

  _onDOMWindowCreated(window) {
    if (!window[this._addedScrollbarsStylesheetSymbol] && this.scrollbarsHidden) {
      const styleSheetService = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Components.interfaces.nsIStyleSheetService);
      const ioService = Cc["@mozilla.org/network/io-service;1"].getService(Components.interfaces.nsIIOService);
      const uri = ioService.newURI('chrome://juggler/content/content/hidden-scrollbars.css', null, null);
      const sheet = styleSheetService.preloadSheet(uri, styleSheetService.AGENT_SHEET);
      window.windowUtils.addSheet(sheet, styleSheetService.AGENT_SHEET);
      window[this._addedScrollbarsStylesheetSymbol] = true;
    }
    const frame = this._docShellToFrame.get(window.docShell) || null;
    if (!frame)
      return;
    frame._onGlobalObjectCleared();
  }

  setScrollbarsHidden(hidden) {
    this.scrollbarsHidden = hidden;
  }

  _onWorkerCreated(workerDebugger) {
    // Note: we do not interoperate with firefox devtools.
    if (workerDebugger.isInitialized)
      return;
    const frame = this._frameForWorker(workerDebugger);
    if (!frame)
      return;
    const worker = new Worker(frame, workerDebugger);
    this._workers.set(workerDebugger, worker);
    this.emit(FrameTree.Events.WorkerCreated, worker);
  }

  _onWorkerDestroyed(workerDebugger) {
    const worker = this._workers.get(workerDebugger);
    if (!worker)
      return;
    worker.dispose();
    this._workers.delete(workerDebugger);
    this.emit(FrameTree.Events.WorkerDestroyed, worker);
  }

  allFramesInBrowsingContextGroup(group) {
    const frames = [];
    for (const frameTree of (group.__jugglerFrameTrees || []))
      frames.push(...frameTree.frames());
    return frames;
  }

  isPageReady() {
    return this._pageReady;
  }

  forcePageReady() {
    if (this._pageReady)
      return false;
    this._pageReady = true;
    this.emit(FrameTree.Events.PageReady);
    return true;
  }

  addBinding(worldName, name, script) {
    worldName = worldName || '';
    const world = this._ensureWorld(worldName);
    world._bindings.set(name, script);
    for (const frame of this.frames())
      frame._addBinding(worldName, name, script);
  }

  frameForDocShell(docShell) {
    return this._docShellToFrame.get(docShell) || null;
  }

  frame(frameId) {
    return this._frameIdToFrame.get(frameId) || null;
  }

  frames() {
    let result = [];
    collect(this._mainFrame);
    return result;

    function collect(frame) {
      result.push(frame);
      for (const subframe of frame._children)
        collect(subframe);
    }
  }

  mainFrame() {
    return this._mainFrame;
  }

  dispose() {
    this._browsingContextGroup.__jugglerFrameTrees.delete(this);
    this._wdm.removeListener(this._wdmListener);
    this._runtime.dispose();
    helper.removeListeners(this._eventListeners);
  }

  onStateChange(progress, request, flag, status) {
    if (!(request instanceof Ci.nsIChannel))
      return;
    const channel = request.QueryInterface(Ci.nsIChannel);
    const docShell = progress.DOMWindow.docShell;
    const frame = this._docShellToFrame.get(docShell);
    if (!frame) {
      dump(`ERROR: got a state changed event for un-tracked docshell!\n`);
      return;
    }

    if (!channel.isDocument) {
      // Somehow, we can get worker requests here,
      // while we are only interested in frame documents.
      return;
    }

    const isStart = flag & Ci.nsIWebProgressListener.STATE_START;
    const isTransferring = flag & Ci.nsIWebProgressListener.STATE_TRANSFERRING;
    const isStop = flag & Ci.nsIWebProgressListener.STATE_STOP;
    const isDocument = flag & Ci.nsIWebProgressListener.STATE_IS_DOCUMENT;

    if (isStart) {
      // Starting a new navigation.
      frame._pendingNavigationId = channelId(channel);
      frame._pendingNavigationURL = channel.URI.spec;
      this.emit(FrameTree.Events.NavigationStarted, frame);
    } else if (isTransferring || (isStop && frame._pendingNavigationId && !status)) {
      // Navigation is committed.
      for (const subframe of frame._children)
        this._detachFrame(subframe);
      const navigationId = frame._pendingNavigationId;
      frame._pendingNavigationId = null;
      frame._pendingNavigationURL = null;
      frame._lastCommittedNavigationId = navigationId;
      frame._url = channel.URI.spec;
      this.emit(FrameTree.Events.NavigationCommitted, frame);
      if (frame === this._mainFrame)
        this.forcePageReady();
    } else if (isStop && frame._pendingNavigationId && status) {
      // Navigation is aborted.
      const navigationId = frame._pendingNavigationId;
      frame._pendingNavigationId = null;
      frame._pendingNavigationURL = null;
      // Always report download navigation as failure to match other browsers.
      const errorText = helper.getNetworkErrorStatusText(status);
      this.emit(FrameTree.Events.NavigationAborted, frame, navigationId, errorText);
      if (frame === this._mainFrame && status !== Cr.NS_BINDING_ABORTED)
        this.forcePageReady();
    }

    if (isStop && isDocument)
      this.emit(FrameTree.Events.Load, frame);
  }

  onLocationChange(progress, request, location, flags) {
    const docShell = progress.DOMWindow.docShell;
    const frame = this._docShellToFrame.get(docShell);
    const sameDocumentNavigation = !!(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT);
    if (frame && sameDocumentNavigation) {
      frame._url = location.spec;
      this.emit(FrameTree.Events.SameDocumentNavigation, frame);
    }
  }

  _onDocShellCreated(docShell) {
    // Bug 1142752: sometimes, the docshell appears to be immediately
    // destroyed, bailout early to prevent random exceptions.
    if (docShell.isBeingDestroyed())
      return;
    // If this docShell doesn't belong to our frame tree - do nothing.
    let root = docShell;
    while (root.parent)
      root = root.parent;
    if (root === this._mainFrame._docShell)
      this._createFrame(docShell);
  }

  _createFrame(docShell) {
    const parentFrame = this._docShellToFrame.get(docShell.parent) || null;
    const frame = new Frame(this, this._runtime, docShell, parentFrame);
    this._docShellToFrame.set(docShell, frame);
    this._frameIdToFrame.set(frame.id(), frame);
    this.emit(FrameTree.Events.FrameAttached, frame);
    // Create execution context **after** reporting frame.
    // This is our protocol contract.
    if (frame.domWindow())
      frame._onGlobalObjectCleared();
    return frame;
  }

  _onDocShellDestroyed(docShell) {
    const frame = this._docShellToFrame.get(docShell);
    if (frame)
      this._detachFrame(frame);
  }

  _detachFrame(frame) {
    // Detach all children first
    for (const subframe of frame._children)
      this._detachFrame(subframe);
    this._docShellToFrame.delete(frame._docShell);
    this._frameIdToFrame.delete(frame.id());
    if (frame._parentFrame)
      frame._parentFrame._children.delete(frame);
    frame._parentFrame = null;
    frame.dispose();
    this.emit(FrameTree.Events.FrameDetached, frame);
  }
}

FrameTree.Events = {
  FrameAttached: 'frameattached',
  FrameDetached: 'framedetached',
  WorkerCreated: 'workercreated',
  WorkerDestroyed: 'workerdestroyed',
  WebSocketCreated: 'websocketcreated',
  WebSocketOpened: 'websocketopened',
  WebSocketClosed: 'websocketclosed',
  WebSocketFrameReceived: 'websocketframereceived',
  WebSocketFrameSent: 'websocketframesent',
  NavigationStarted: 'navigationstarted',
  NavigationCommitted: 'navigationcommitted',
  NavigationAborted: 'navigationaborted',
  SameDocumentNavigation: 'samedocumentnavigation',
  PageReady: 'pageready',
  Load: 'load',
};

class IsolatedWorld {
  constructor(name) {
    this._name = name;
    this._scriptsToEvaluateOnNewDocument = [];
    this._bindings = new Map();
  }
}

class Frame {
  constructor(frameTree, runtime, docShell, parentFrame) {
    this._frameTree = frameTree;
    this._runtime = runtime;
    this._docShell = docShell;
    this._children = new Set();
    this._frameId = helper.browsingContextToFrameId(this._docShell.browsingContext);
    this._parentFrame = null;
    this._url = '';
    if (docShell.domWindow && docShell.domWindow.location)
      this._url = docShell.domWindow.location.href;
    if (parentFrame) {
      this._parentFrame = parentFrame;
      parentFrame._children.add(this);
    }

    this._lastCommittedNavigationId = null;
    this._pendingNavigationId = null;
    this._pendingNavigationURL = null;

    this._textInputProcessor = null;

    this._worldNameToContext = new Map();
    this._initialNavigationDone = false;

    this._webSocketListenerInnerWindowId = 0;
    // WebSocketListener calls frameReceived event before webSocketOpened.
    // To avoid this, serialize event reporting.
    this._webSocketInfos = new Map();

    const dispatchWebSocketFrameReceived = (webSocketSerialID, frame) => this._frameTree.emit(FrameTree.Events.WebSocketFrameReceived, {
      frameId: this._frameId,
      wsid: webSocketSerialID + '',
      opcode: frame.opCode,
      data: frame.opCode !== 1 ? btoa(frame.payload) : frame.payload,
    });
    this._webSocketListener = {
      QueryInterface: ChromeUtils.generateQI([Ci.nsIWebSocketEventListener, ]),

      webSocketCreated: (webSocketSerialID, uri, protocols) => {
        this._frameTree.emit(FrameTree.Events.WebSocketCreated, {
          frameId: this._frameId,
          wsid: webSocketSerialID + '',
          requestURL: uri,
        });
        this._webSocketInfos.set(webSocketSerialID, {
          opened: false,
          pendingIncomingFrames: [],
        });
      },

      webSocketOpened: (webSocketSerialID, effectiveURI, protocols, extensions, httpChannelId) => {
        this._frameTree.emit(FrameTree.Events.WebSocketOpened, {
          frameId: this._frameId,
          requestId: httpChannelId + '',
          wsid: webSocketSerialID + '',
          effectiveURL: effectiveURI,
        });
        const info = this._webSocketInfos.get(webSocketSerialID);
        info.opened = true;
        for (const frame of info.pendingIncomingFrames)
          dispatchWebSocketFrameReceived(webSocketSerialID, frame);
      },

      webSocketMessageAvailable: (webSocketSerialID, data, messageType) => {
        // We don't use this event.
      },

      webSocketClosed: (webSocketSerialID, wasClean, code, reason) => {
        this._webSocketInfos.delete(webSocketSerialID);
        let error = '';
        if (!wasClean) {
          const keys = Object.keys(Ci.nsIWebSocketChannel);
          for (const key of keys) {
            if (Ci.nsIWebSocketChannel[key] === code)
              error = key;
          }
        }
        this._frameTree.emit(FrameTree.Events.WebSocketClosed, {
          frameId: this._frameId,
          wsid: webSocketSerialID + '',
          error,
        });
      },

      frameReceived: (webSocketSerialID, frame) => {
        // Report only text and binary frames.
        if (frame.opCode !== 1 && frame.opCode !== 2)
          return;
        const info = this._webSocketInfos.get(webSocketSerialID);
        if (info.opened)
          dispatchWebSocketFrameReceived(webSocketSerialID, frame);
        else
          info.pendingIncomingFrames.push(frame);
      },

      frameSent: (webSocketSerialID, frame) => {
        // Report only text and binary frames.
        if (frame.opCode !== 1 && frame.opCode !== 2)
          return;
        this._frameTree.emit(FrameTree.Events.WebSocketFrameSent, {
          frameId: this._frameId,
          wsid: webSocketSerialID + '',
          opcode: frame.opCode,
          data: frame.opCode !== 1 ? btoa(frame.payload) : frame.payload,
        });
      },
    };
  }

  _createIsolatedContext(name) {
    const principal = [this.domWindow()]; // extended principal
    const sandbox = Cu.Sandbox(principal, {
      sandboxPrototype: this.domWindow(),
      wantComponents: false,
      wantExportHelpers: false,
      wantXrays: true,
    });
    const world = this._runtime.createExecutionContext(this.domWindow(), sandbox, {
      frameId: this.id(),
      name,
    });
    this._worldNameToContext.set(name, world);
    return world;
  }

  unsafeObject(objectId) {
    for (const context of this._worldNameToContext.values()) {
      const result = context.unsafeObject(objectId);
      if (result)
        return result.object;
    }
    throw new Error('Cannot find object with id = ' + objectId);
  }

  dispose() {
    for (const context of this._worldNameToContext.values())
      this._runtime.destroyExecutionContext(context);
    this._worldNameToContext.clear();
  }

  _addBinding(worldName, name, script) {
    let executionContext = this._worldNameToContext.get(worldName);
    if (worldName && !executionContext)
      executionContext = this._createIsolatedContext(worldName);
    if (executionContext)
      executionContext.addBinding(name, script);
  }

  _onGlobalObjectCleared() {
    const webSocketService = this._frameTree._webSocketEventService;
    if (this._webSocketListenerInnerWindowId)
      webSocketService.removeListener(this._webSocketListenerInnerWindowId, this._webSocketListener);
    this._webSocketListenerInnerWindowId = this.domWindow().windowGlobalChild.innerWindowId;
    webSocketService.addListener(this._webSocketListenerInnerWindowId, this._webSocketListener);

    for (const context of this._worldNameToContext.values())
      this._runtime.destroyExecutionContext(context);
    this._worldNameToContext.clear();

    this._worldNameToContext.set('', this._runtime.createExecutionContext(this.domWindow(), this.domWindow(), {
      frameId: this._frameId,
      name: '',
    }));
    for (const [name, world] of this._frameTree._isolatedWorlds) {
      if (name)
        this._createIsolatedContext(name);
      const executionContext = this._worldNameToContext.get(name);
      // Add bindings before evaluating scripts.
      for (const [name, script] of world._bindings)
        executionContext.addBinding(name, script);
      for (const script of world._scriptsToEvaluateOnNewDocument)
        executionContext.evaluateScriptSafely(script);
    }
  }

  mainExecutionContext() {
    return this._worldNameToContext.get('');
  }

  textInputProcessor() {
    if (!this._textInputProcessor) {
      this._textInputProcessor = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
      this._textInputProcessor.beginInputTransactionForTests(this._docShell.DOMWindow);
    }
    return this._textInputProcessor;
  }

  pendingNavigationId() {
    return this._pendingNavigationId;
  }

  pendingNavigationURL() {
    return this._pendingNavigationURL;
  }

  lastCommittedNavigationId() {
    return this._lastCommittedNavigationId;
  }

  docShell() {
    return this._docShell;
  }

  domWindow() {
    return this._docShell.domWindow;
  }

  name() {
    const frameElement = this._docShell.domWindow.frameElement;
    let name = '';
    if (frameElement)
      name = frameElement.getAttribute('name') || frameElement.getAttribute('id') || '';
    return name;
  }

  parentFrame() {
    return this._parentFrame;
  }

  id() {
    return this._frameId;
  }

  url() {
    return this._url;
  }

}

class Worker {
  constructor(frame, workerDebugger) {
    this._frame = frame;
    this._workerId = helper.generateId();
    this._workerDebugger = workerDebugger;

    workerDebugger.initialize('chrome://juggler/content/content/WorkerMain.js');

    this._channel = new SimpleChannel(`content::worker[${this._workerId}]`);
    this._channel.setTransport({
      sendMessage: obj => workerDebugger.postMessage(JSON.stringify(obj)),
      dispose: () => {},
    });
    this._workerDebuggerListener = {
      QueryInterface: ChromeUtils.generateQI([Ci.nsIWorkerDebuggerListener]),
      onMessage: msg => void this._channel._onMessage(JSON.parse(msg)),
      onClose: () => void this._channel.dispose(),
      onError: (filename, lineno, message) => {
        dump(`Error in worker: ${message} @${filename}:${lineno}\n`);
      },
    };
    workerDebugger.addListener(this._workerDebuggerListener);
  }

  channel() {
    return this._channel;
  }

  frame() {
    return this._frame;
  }

  id() {
    return this._workerId;
  }

  url() {
    return this._workerDebugger.url;
  }

  dispose() {
    this._channel.dispose();
    this._workerDebugger.removeListener(this._workerDebuggerListener);
  }
}

function channelId(channel) {
  if (channel instanceof Ci.nsIIdentChannel) {
    const identChannel = channel.QueryInterface(Ci.nsIIdentChannel);
    return String(identChannel.channelId);
  }
  return helper.generateId();
}


var EXPORTED_SYMBOLS = ['FrameTree'];
this.FrameTree = FrameTree;


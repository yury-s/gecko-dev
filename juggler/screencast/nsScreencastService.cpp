/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsScreencastService.h"

#include "mozilla/ClearOnShutdown.h"
#include "mozilla/PresShell.h"
#include "mozilla/StaticPtr.h"
#include "nsIDocShell.h"
#include "nsThreadManager.h"
#include "nsView.h"
#include "nsViewManager.h"
#include "webrtc/modules/desktop_capture/desktop_capturer.h"
#include "webrtc/modules/desktop_capture/desktop_capture_options.h"
#include "webrtc/modules/desktop_capture/desktop_device_info.h"
#include "webrtc/modules/desktop_capture/desktop_frame.h"
#include "webrtc/modules/video_capture/video_capture.h"
#include "mozilla/widget/PlatformWidgetTypes.h"
#include "video_engine/desktop_capture_impl.h"

namespace mozilla {

NS_IMPL_ISUPPORTS(nsScreencastService, nsIScreencastService)

namespace {

StaticRefPtr<nsScreencastService> gScreencastService;

}

class nsScreencastService::Session : public rtc::VideoSinkInterface<webrtc::VideoFrame> {
 public:
  Session(int sessionId, const nsCString& windowId)
      : mSessionId(sessionId),
        mCaptureModule(webrtc::DesktopCaptureImpl::Create(
            sessionId, windowId.get(), webrtc::CaptureDeviceType::Window)) {
  }

  bool Start() {
    webrtc::VideoCaptureCapability capability;
    // The size is ignored in fact.
    capability.width = 1280;
    capability.height = 960;
    capability.maxFPS = 24;
    capability.videoType = webrtc::VideoType::kI420;
    int error = mCaptureModule->StartCapture(capability);
    if (error) {
      fprintf(stderr, "StartCapture error %d\n", error);
      return false;
    }

    mCaptureModule->RegisterCaptureDataCallback(this);
    return true;
  }

  void Stop() {
    mCaptureModule->DeRegisterCaptureDataCallback(this);
    int error = mCaptureModule->StopCapture();
    if (error) {
      fprintf(stderr, "StopCapture error %d\n", error);
      return;
    }
    fprintf(stderr, "nsScreencastService::Session::Stop mSessionId=%d\n", mSessionId);
  }

  // These callbacks end up running on the VideoCapture thread.
  void OnFrame(const webrtc::VideoFrame& videoFrame) override {
    fprintf(stderr, "Session::OnFrame mSessionId=%d  %dx%d [sz=%ud]\n", mSessionId, videoFrame.width(), videoFrame.height(), videoFrame.size());
  }

 private:
  int mSessionId;
  rtc::scoped_refptr<webrtc::VideoCaptureModule> mCaptureModule;
};


// static
already_AddRefed<nsIScreencastService> nsScreencastService::GetSingleton() {
  if (gScreencastService) {
    return do_AddRef(gScreencastService);
  }

  gScreencastService = new nsScreencastService();
  // ClearOnShutdown(&gScreencastService);
  return do_AddRef(gScreencastService);
}

nsScreencastService::nsScreencastService() = default;

nsScreencastService::~nsScreencastService() {
}

nsresult nsScreencastService::StartVideoRecording(nsIDocShell* aDocShell, const nsACString& aFileName, int32_t* sessionId) {
  fprintf(stderr, "nsScreencastService::StartVideoRecording aDocShell=%p NS_IsMainThread() = %d\n", aDocShell, NS_IsMainThread());
  MOZ_RELEASE_ASSERT(NS_IsMainThread(), "Screencast service must be started on the Main thread.");

  *sessionId = -1;
  // webrtc::DesktopCaptureOptions options;
  // std::unique_ptr<webrtc::DesktopCapturer> pWindowCapturer =
  //     webrtc::DesktopCapturer::CreateWindowCapturer(std::move(options));

  PresShell* presShell = aDocShell->GetPresShell();
  if (!presShell)
    return NS_ERROR_UNEXPECTED;
  nsViewManager* viewManager = presShell->GetViewManager();
  if (!viewManager)
    return NS_ERROR_UNEXPECTED;
  nsView* view = viewManager->GetRootView();
  if (!view)
    return NS_ERROR_UNEXPECTED;
  nsIWidget* widget = view->GetWidget();

#ifdef MOZ_WIDGET_GTK
  mozilla::widget::CompositorWidgetInitData initData;
  widget->GetCompositorWidgetInitData(&initData);
  const mozilla::widget::GtkCompositorWidgetInitData& gtkInitData = initData.get_GtkCompositorWidgetInitData();
# ifdef MOZ_X11
  fprintf(stderr, "    gtkInitData.XWindow()=%lu\n", gtkInitData.XWindow());
  nsCString windowId;
  windowId.AppendPrintf("%lu", gtkInitData.XWindow());

  *sessionId = ++mLastSessionId;
  auto session = std::make_unique<Session>(*sessionId, windowId);
  if (!session->Start())
    return NS_ERROR_FAILURE;

  mIdToSession.emplace(*sessionId, std::move(session));
# else
  // TODO: support in wayland
  return NS_ERROR_NOT_IMPLEMENTED;
# endif
#endif
  return NS_OK;
}

nsresult nsScreencastService::StopVideoRecording(int32_t sessionId) {
  fprintf(stderr, "nsScreencastService::StopVideoRecording sessionId=%d\n", sessionId);
  auto it = mIdToSession.find(sessionId);
  if (it == mIdToSession.end())
    return NS_ERROR_INVALID_ARG;
  it->second->Stop();
  mIdToSession.erase(it);
  return NS_OK;
}

}  // namespace mozilla

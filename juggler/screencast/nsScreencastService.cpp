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
#include "VideoEngine.h"

namespace mozilla {

NS_IMPL_ISUPPORTS(nsScreencastService, nsIScreencastService)

namespace {

class VideoCaptureListener : public rtc::VideoSinkInterface<webrtc::VideoFrame> {
 public:
  VideoCaptureListener(int32_t capnum) : mCapnum(capnum) {}

  // These callbacks end up running on the VideoCapture thread.
  // From  VideoCaptureCallback
  void OnFrame(const webrtc::VideoFrame& videoFrame) override {
    fprintf(stderr, "VideoCaptureListener::OnFrame mCapnum=%d  %dx%d [sz=%ud]\n", mCapnum, videoFrame.width(), videoFrame.height(), videoFrame.size());
  }

 private:
  int32_t mCapnum;
};

mozilla::camera::VideoEngine* GetWindowVideoEngine() {
  static RefPtr<mozilla::camera::VideoEngine> engine = []() {
    auto config = MakeUnique<webrtc::Config>();
    config->Set<webrtc::CaptureDeviceInfo>(
        new webrtc::CaptureDeviceInfo(webrtc::CaptureDeviceType::Window));
    fprintf(stderr, "CreateWindowVideoEngine() \n");
    return mozilla::camera::VideoEngine::Create(std::move(config));
  }();
  return engine.get();
}

void StartCapturingWindow(const nsCString& windowId) {
  mozilla::camera::VideoEngine* engine = GetWindowVideoEngine();
  int numdev = -1;
  engine->CreateVideoCapture(numdev, windowId.get());
  fprintf(stderr, "CreateVideoCapture windowId=%s\n", windowId.get());
  VideoCaptureListener* listener = new VideoCaptureListener(numdev);
  engine->WithEntry(numdev, [listener](mozilla::camera::VideoEngine::CaptureEntry& cap) {
    if (!cap.VideoCapture()) {
      fprintf(stderr, "StartCapturingWindow failed to create VideoCapture\n");
      return;
    }

    webrtc::VideoCaptureCapability capability;
    // The size is ignored in fact.
    capability.width = 1280;
    capability.height = 960;
    capability.maxFPS = 24;
    capability.videoType = webrtc::VideoType::kI420;
    int error = cap.VideoCapture()->StartCapture(capability);
    if (error) {
      fprintf(stderr, "StartCapture error %d\n", error);
      return;
    }

    cap.VideoCapture()->RegisterCaptureDataCallback(listener);
  });
}

StaticRefPtr<nsScreencastService> gScreencastService;
}

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
  fprintf(stderr, "\n\n\n*********nsScreencastService::~nsScreencastService\n");

}

nsresult nsScreencastService::StartVideoRecording(nsIDocShell* aDocShell, const nsACString& aFileName) {
  fprintf(stderr, "nsScreencastService::StartVideoRecording aDocShell=%p NS_IsMainThread() = %d\n", aDocShell, NS_IsMainThread());
  MOZ_RELEASE_ASSERT(NS_IsMainThread(), "Screencast service must be started on the Main thread.");

  webrtc::DesktopCaptureOptions options;
  std::unique_ptr<webrtc::DesktopCapturer> pWindowCapturer =
      webrtc::DesktopCapturer::CreateWindowCapturer(std::move(options));

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
  StartCapturingWindow(windowId);
# else
  // TODO: support in wayland
  return NS_ERROR_NOT_IMPLEMENTED;
# endif
#endif
  widget->SetDrawingListener([] (mozilla::gfx::DrawTarget* drawTarget) {
    MOZ_RELEASE_ASSERT(NS_IsInCompositorThread(), "Screencast drawing listener is expected to be called on the Compositor thread.");
    fprintf(stderr, "DrawingListener drawTarget=%p\n", drawTarget);
    RefPtr<gfx::SourceSurface> snapshot = drawTarget->Snapshot();
    if (!snapshot)
      return;

    // fprintf(stderr, "    GetBackendType()=%hhd\n", drawTarget->GetBackendType());
    // fprintf(stderr, "    type=%hhd\n", snapshot->GetType());
    // fprintf(stderr, "    format=%hhd\n", snapshot->GetFormat());
    fprintf(stderr, "    size=%d x %d\n", snapshot->GetSize().width, snapshot->GetSize().height);
    RefPtr<gfx::DataSourceSurface> dataSurface = snapshot->GetDataSurface();
    if (dataSurface)
      fprintf(stderr, "    got dataSurface %p Stride() = %d\n", dataSurface.get(), dataSurface->Stride());
  });
//    nsWindow.h
// GetLayerManager
// GetCompositor
  return NS_OK;
}

nsresult nsScreencastService::StopVideoRecording(nsIDocShell* aDocShell) {
  fprintf(stderr, "nsScreencastService::StopVideoRecording aDocShell=%p\n", aDocShell);
  return NS_OK;
}

}  // namespace mozilla

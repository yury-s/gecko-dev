/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/widget/PlatformWidgetTypes.h"
#include "HeadlessCompositorWidget.h"
#include "VsyncDispatcher.h"

namespace mozilla {
namespace widget {

HeadlessCompositorWidget::HeadlessCompositorWidget(
    const HeadlessCompositorWidgetInitData& aInitData,
    const layers::CompositorOptions& aOptions, HeadlessWidget* aWindow)
    : CompositorWidget(aOptions), mWidget(aWindow) {
  mClientSize = aInitData.InitialClientSize();
}

already_AddRefed<gfx::DrawTarget> HeadlessCompositorWidget::StartRemoteDrawingInRegion(
    LayoutDeviceIntRegion& aInvalidRegion, layers::BufferMode* aBufferMode) {
  *aBufferMode = layers::BufferMode::BUFFER_NONE;
  fprintf(stderr, "HeadlessCompositorWidget::StartRemoteDrawingInRegion %p %dx%d\n", this, GetClientSize().width, GetClientSize().height);
  gfx::SurfaceFormat format = gfx::SurfaceFormat::B8G8R8A8;
  gfx::IntSize size(1280, 960);
  mDrawTarget = gfx::Factory::CreateCaptureDrawTargetForData(
          gfx::BackendType::SKIA, size, format, size.width * 4, size.width * 4 * size.height);
  return do_AddRef(mDrawTarget);
}

void HeadlessCompositorWidget::EndRemoteDrawingInRegion(
    gfx::DrawTarget* aDrawTarget, const LayoutDeviceIntRegion& aInvalidRegion) {
  fprintf(stderr, "HeadlessCompositorWidget::EndRemoteDrawingInRegion %p %p\n", this, aDrawTarget);
  if (!mDrawTarget)
    return;
  RefPtr<gfx::SourceSurface> snapshot = mDrawTarget->Snapshot();
  if (!snapshot)
    return;
  fprintf(stderr, "    got snapshot %p\n", snapshot.get());
  RefPtr<gfx::DataSourceSurface> dataSurface = snapshot->GetDataSurface();
  if (!dataSurface)
    return;
  fprintf(stderr, "    got dataSurface %p Stride() = %d\n", dataSurface.get(), dataSurface->Stride());
  // SurfaceToPackedBGRA(dataSurface.get());
}

void HeadlessCompositorWidget::ObserveVsync(VsyncObserver* aObserver) {
  if (RefPtr<CompositorVsyncDispatcher> cvd =
          mWidget->GetCompositorVsyncDispatcher()) {
    cvd->SetCompositorVsyncObserver(aObserver);
  }
}

nsIWidget* HeadlessCompositorWidget::RealWidget() { return mWidget; }

void HeadlessCompositorWidget::NotifyClientSizeChanged(
    const LayoutDeviceIntSize& aClientSize) {
  mClientSize = aClientSize;
}

LayoutDeviceIntSize HeadlessCompositorWidget::GetClientSize() {
  return mClientSize;
}

uintptr_t HeadlessCompositorWidget::GetWidgetKey() {
  return reinterpret_cast<uintptr_t>(mWidget);
}

}  // namespace widget
}  // namespace mozilla

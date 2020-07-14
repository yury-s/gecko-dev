/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/layers/CompositorThread.h"
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

void HeadlessCompositorWidget::SetSnapshotListener(HeadlessWidget::SnapshotListener&& listener) {
  MOZ_ASSERT(NS_IsMainThread());

  layers::CompositorThread()->Dispatch(NewRunnableMethod<HeadlessWidget::SnapshotListener&&>(
      "HeadlessCompositorWidget::SetSnapshotListener", this,
      &HeadlessCompositorWidget::SetSnapshotListenerOnCompositorThread,
      std::move(listener)));
}

void HeadlessCompositorWidget::SetSnapshotListenerOnCompositorThread(HeadlessWidget::SnapshotListener&& listener) {
  MOZ_ASSERT(NS_IsInCompositorThread());
  mSnapshotListener = std::move(listener);
  UpdateDrawTarget();
}

already_AddRefed<gfx::DrawTarget> HeadlessCompositorWidget::StartRemoteDrawingInRegion(
    LayoutDeviceIntRegion& aInvalidRegion, layers::BufferMode* aBufferMode) {
  if (!mDrawTarget)
    return nullptr;

  *aBufferMode = layers::BufferMode::BUFFER_NONE;
  RefPtr<gfx::DrawTarget> result = mDrawTarget;
  return result.forget();
}

void HeadlessCompositorWidget::EndRemoteDrawingInRegion(
    gfx::DrawTarget* aDrawTarget, const LayoutDeviceIntRegion& aInvalidRegion) {
  if (!mDrawTarget)
    return;

  if (!mSnapshotListener)
    return;

  RefPtr<gfx::SourceSurface> snapshot = mDrawTarget->Snapshot();
  if (!snapshot) {
    fprintf(stderr, "Failed to get snapshot of draw target\n");
    return;
  }

  RefPtr<gfx::DataSourceSurface> dataSurface = snapshot->GetDataSurface();
  if (!dataSurface) {
    fprintf(stderr, "Failed to get data surface from snapshot\n");
    return;
  }

  mSnapshotListener(std::move(dataSurface));
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
  UpdateDrawTarget();
}

void HeadlessCompositorWidget::UpdateDrawTarget() {
  if (!mSnapshotListener) {
    mDrawTarget = nullptr;
    return;
  }

  if (mClientSize.IsEmpty()) {
    mDrawTarget = nullptr;
    return;
  }

  gfx::SurfaceFormat format = gfx::SurfaceFormat::B8G8R8A8;
  gfx::IntSize size = mClientSize.ToUnknownSize();
  // TODO: this is called on Main thread, while Start/End drawing are on Compositor thread.
  mDrawTarget = mozilla::gfx::Factory::CreateDrawTarget(
      mozilla::gfx::BackendType::SKIA, size, format);
}

LayoutDeviceIntSize HeadlessCompositorWidget::GetClientSize() {
  return mClientSize;
}

uintptr_t HeadlessCompositorWidget::GetWidgetKey() {
  return reinterpret_cast<uintptr_t>(mWidget);
}

}  // namespace widget
}  // namespace mozilla

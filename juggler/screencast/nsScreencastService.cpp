/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsScreencastService.h"

#include "mozilla/ClearOnShutdown.h"
#include "mozilla/PresShell.h"
#include "mozilla/StaticPtr.h"
#include "nsIDocShell.h"
#include "nsView.h"
#include "nsViewManager.h"

namespace mozilla {

NS_IMPL_ISUPPORTS(nsScreencastService, nsIScreencastService)

static StaticRefPtr<nsScreencastService> gScreencastService;

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
  fprintf(stderr, "nsScreencastService::StartVideoRecording aDocShell=%p\n", aDocShell);
  fprintf(stderr, "    thread=%p name=%s\n", PR_GetCurrentThread(), PR_GetThreadName(PR_GetCurrentThread()));

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
  fprintf(stderr, "    widget=%p\n", widget);
  widget->SetDrawingListener([widget] (mozilla::gfx::DrawTarget* drawingTarget) {
    fprintf(stderr, "    DrawingListener drawingTarget=%p\n", drawingTarget);
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

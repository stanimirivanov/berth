import { MATERIAL_ANIMATIONS } from "@angular/material/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter, type UrlMatcher, UrlSerializer } from "@angular/router";
import { App } from "./app";
import { Infrastructure } from "./infrastructure/infrastructure";
import { OperationHistory } from "./operation-history/operation-history";
import { OperationUrlSerializer } from "./operation-history/operation-url-serializer";

/** Reuse the inbox view when navigating between the list and a saved operation. */
const matchHistory: UrlMatcher = (segments) => {
  if (segments[0]?.path === "operations" && segments.length <= 2) {
    return { consumed: segments };
  }
  return null;
};

bootstrapApplication(App, {
  providers: [
    // The default motion path asks CDK to inject an unapproved style element.
    { provide: MATERIAL_ANIMATIONS, useValue: { animationsDisabled: true } },
    { provide: UrlSerializer, useClass: OperationUrlSerializer },
    provideRouter([
      {
        path: "",
        pathMatch: "full",
        component: Infrastructure,
        title: "Berth · Infrastructure",
      },
      {
        matcher: matchHistory,
        component: OperationHistory,
        title: "Berth · Operation history",
      },
    ]),
  ],
});

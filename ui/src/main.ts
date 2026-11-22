import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter, UrlSerializer } from "@angular/router";
import { App } from "./app";
import { Infrastructure } from "./infrastructure/infrastructure";
import { OperationHistory } from "./operation-history/operation-history";
import { OperationUrlSerializer } from "./operation-history/operation-url-serializer";

bootstrapApplication(App, {
  providers: [
    { provide: UrlSerializer, useClass: OperationUrlSerializer },
    provideRouter([
      {
        path: "",
        pathMatch: "full",
        component: Infrastructure,
        title: "Berth · Infrastructure",
      },
      {
        path: "operations",
        component: OperationHistory,
        title: "Berth · Operation history",
      },
      {
        path: "operations/:operation",
        component: OperationHistory,
        title: "Berth · Operation history",
      },
    ]),
  ],
});

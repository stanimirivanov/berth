import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter } from "@angular/router";
import { App } from "./app";
import { Infrastructure } from "./infrastructure/infrastructure";
import { OperationHistory } from "./operation-history/operation-history";

bootstrapApplication(App, {
  providers: [
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

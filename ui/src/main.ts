import { ChangeDetectionStrategy, Component } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import {
  provideRouter,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from "@angular/router";
import { HistoryStore } from "./history.store";
import { OperationHistory } from "./operation-history";

/** Reserve the landing route while the inventory service is pending. */
@Component({
  selector: "berth-infrastructure",
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Infrastructure</h1>
    <p>Inventory is not available yet.</p>
    <p><a routerLink="/operations">Open operation history</a></p>
  `,
})
class Infrastructure {}

/** Shared navigation and tab-memory history access for the routed views. */
@Component({
  selector: "berth-app",
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  providers: [HistoryStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header>
      <a routerLink="/" class="brand" aria-label="Berth home">BERTH</a>
      <nav class="main-navigation" aria-label="Main navigation">
        <a routerLink="/" routerLinkActive="current" ariaCurrentWhenActive="page"
          [routerLinkActiveOptions]="{ exact: true }">Infrastructure</a>
        <a routerLink="/operations" routerLinkActive="current" ariaCurrentWhenActive="page">Operation history</a>
      </nav>
      <span class="readonly">Read only</span>
    </header>
    <main><router-outlet /></main>
    <footer>No lifecycle controls. No provider requests. Historical evidence remains unchanged.</footer>
  `,
})
class App {}

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

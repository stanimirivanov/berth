import { ChangeDetectionStrategy, Component } from "@angular/core";
import { RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { HistoryStore } from "./operation-history/history-store";

/** Shared navigation and tab-memory history access for the routed views. */
@Component({
  selector: "berth-app",
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  providers: [HistoryStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./app.html",
})
export class App {}

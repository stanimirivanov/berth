import {
  DefaultUrlSerializer,
  PRIMARY_OUTLET,
  UrlSegment,
  UrlSegmentGroup,
  UrlTree,
} from "@angular/router";
import { isOperationId } from "./history-store";

const detailPath = /^\/operations\/([^/?#]+)(?:[?#].*)?$/;
const invalidOperation = "invalid-operation-link";

/** Preserve malformed saved links while routing them to the history error view. */
export class OperationUrlSerializer extends DefaultUrlSerializer {
  /** Validate the raw ID before Angular interprets matrix or outlet syntax. */
  override parse(url: string) {
    const identifier = detailPath.exec(url)?.[1];
    if (!identifier || isOperationId(identifier)) {
      return super.parse(url);
    }
    const detail = new UrlSegmentGroup(
      [
        new UrlSegment("operations", {}),
        new UrlSegment(invalidOperation, { requestedUrl: url }),
      ],
      {},
    );
    return new UrlTree(new UrlSegmentGroup([], { [PRIMARY_OUTLET]: detail }));
  }

  /** Keep the original malformed address while Angular renders the error. */
  override serialize(tree: UrlTree) {
    const segments = tree.root.children[PRIMARY_OUTLET]?.segments;
    const detail = segments?.[1];
    const requestedUrl = detail?.parameters.requestedUrl;
    if (
      segments?.length === 2 &&
      segments[0]?.path === "operations" &&
      detail?.path === invalidOperation &&
      requestedUrl &&
      detailPath.test(requestedUrl)
    ) {
      return requestedUrl;
    }
    return super.serialize(tree);
  }
}

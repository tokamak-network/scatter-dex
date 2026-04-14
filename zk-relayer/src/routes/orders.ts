import { Router, Request, Response, RequestHandler } from "express";

/**
 * Legacy /api/private-orders endpoint — retained only as a 410 stub so old
 * frontend bundles get a clear migration error instead of a vague 404.
 *
 * Tracker #29 cleanup retired the underlying PrivateOrderbook + full-proof
 * settle path. All orders now flow through POST /api/authorize-orders.
 */
export function createPrivateOrderRoutes(writeLimiter?: RequestHandler): Router {
  const router = Router();

  if (writeLimiter) router.post("/", writeLimiter);
  router.post("/", (_req: Request, res: Response) => {
    res.status(410).json({
      error: "This endpoint is deprecated. Use POST /api/authorize-orders with an authorize proof.",
      migration:
        "Generate an authorize.circom proof client-side and submit to /api/authorize-orders. " +
        "For same-token scatter: set sellToken == buyToken in the proof.",
    });
  });

  // GET /:pubKeyAx — also retired. The previous response was always [] post-
  // S-M14 since nothing landed in private_orders. Return 410 explicitly so the
  // frontend's history-enrichment fetch can detect and skip cleanly.
  router.get("/:pubKeyAx", (_req: Request, res: Response) => {
    res.status(410).json({ error: "private_orders enrichment retired (tracker #29)" });
  });

  return router;
}

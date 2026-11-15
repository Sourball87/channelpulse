import { Router, type Request, type Response } from "express";
import {
  GetScanbackPromotionParams, GetScanbackPromotionResponse,
  ExportScanbackPromotionParams, ExportScanbackPromotionQueryParams,
  ReconcileScanbackPartnerParams, ReconcileScanbackPartnerBody, ReconcileScanbackPartnerResponse,
  CloseScanbackPartnerParams, CloseScanbackPartnerBody, CloseScanbackPartnerResponse,
} from "@workspace/api-zod";
import { transaction, ScanbackError, loadVerificationContext } from "../lib/scanback-store";
import { buildPromotionTally, reconcilePromotionPartner, closePromotionPartner, promotionWorkbook } from "../lib/scanback-promotions";
import { XLSX_MIME } from "../lib/scanback-export";

const router = Router();
const route = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    const value = await fn(req, res);
    if (!res.headersSent) res.json(value);
  } catch (error) {
    if (error instanceof ScanbackError) res.status(error.status).json({ error: error.message });
    else if (error && typeof error === "object" && "issues" in error)
      res.status(400).json({ error: "Check the partner, reference and required notes." });
    else if (error && typeof error === "object" && "code" in error && error.code === "23505")
      res.status(409).json({ error: "This partner or serial was already approved. Refresh the promotion." });
    else {
      req.log.error({ err: error }, "Promotion reconciliation failed");
      res.status(500).json({ error: "Could not complete reconciliation. Nothing was approved." });
    }
  }
};
router.get("/scanback/promotions/:id", route(async req => {
  const { id } = GetScanbackPromotionParams.parse(req.params);
  return GetScanbackPromotionResponse.parse(await transaction(async c => buildPromotionTally(await loadVerificationContext(c), id)));
}));
router.get("/scanback/promotions/:id/export", route(async (req, res) => {
  const { id } = ExportScanbackPromotionParams.parse(req.params);
  const { accountId } = ExportScanbackPromotionQueryParams.parse(req.query);
  const buffer = await transaction(c => promotionWorkbook(c, id, accountId));
  res.setHeader("Cache-Control", "no-store");
  res.type(XLSX_MIME).attachment(`promotion-tally${accountId == null ? "" : `-${accountId}`}.xlsx`).send(buffer);
}));
router.post("/scanback/promotions/:id/partners/:accountId/reconcile", route(async req => {
  const { id, accountId } = ReconcileScanbackPartnerParams.parse(req.params);
  const input = ReconcileScanbackPartnerBody.parse(req.body);
  return ReconcileScanbackPartnerResponse.parse(await transaction(c => reconcilePromotionPartner(c, id, accountId, input)));
}));
router.post("/scanback/promotions/:id/partners/:accountId/close", route(async req => {
  const { id, accountId } = CloseScanbackPartnerParams.parse(req.params);
  const input = CloseScanbackPartnerBody.parse(req.body);
  return CloseScanbackPartnerResponse.parse(await transaction(c => closePromotionPartner(c, id, accountId, input)));
}));
export default router;

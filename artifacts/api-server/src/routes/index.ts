import { Router, type IRouter } from "express";
import authRouter, { requireAdminSession } from "./auth";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import explorerRouter from "./explorer";
import trendsRouter from "./trends";
import alertsRouter from "./alerts";
import resellersRouter from "./resellers";
import partsRouter from "./parts";
import columnMappingsRouter from "./column-mappings";
import scanbackRouter from "./scanback";
import uploadCenterRouter from "./upload-center";
import programPreviewRouter from "./program-preview";
import serialTrailRouter from "./serial-trail";
import { maskCustomerResponses } from "../lib/customer-display";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(requireAdminSession);
router.use(maskCustomerResponses);
router.use(dashboardRouter);
router.use(explorerRouter);
router.use(trendsRouter);
router.use(alertsRouter);
router.use(resellersRouter);
router.use(partsRouter);
router.use(columnMappingsRouter);
router.use(scanbackRouter);
router.use(uploadCenterRouter);
router.use(programPreviewRouter);
router.use(serialTrailRouter);

export default router;

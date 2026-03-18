import "./env-bootstrap.js";

import { logger } from "./logger.js";
import { startCliService } from "./service/bootstrap.js";

startCliService().catch((error) => {
  logger.error("service.start_failed", { error });
  process.exit(1);
});

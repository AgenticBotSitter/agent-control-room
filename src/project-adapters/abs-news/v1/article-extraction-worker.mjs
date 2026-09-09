import { parentPort, workerData } from "node:worker_threads";
import { extractArticleText } from "./article-extraction.mjs";

if (!parentPort) throw new Error("article_worker_required");
parentPort.postMessage(extractArticleText(workerData.html, workerData.sourceUrl));
parentPort.close();

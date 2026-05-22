import globalState from '../globalState';
import { formatDate } from './utils';

/** 同步 VS Code 中 panxun.stockPrice 到内存（避免 remind 等模块依赖 setStockPrice webview 形成循环引用） */
export function cacheStockPriceData(amountObj: Object) {
  globalState.stockPrice = amountObj;
  globalState.stockPriceCacheDate = formatDate(new Date());
}

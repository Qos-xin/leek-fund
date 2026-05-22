/*--------------------------------------------------------------
 *  Copyright (c) Nicky<giscafer@outlook.com>. All rights reserved.
 *  Licensed under the BSD-3-Clause License.
 *  Github: https://github.com/giscafer
 *-------------------------------------------------------------*/

import { ConfigurationChangeEvent, ExtensionContext, TreeView, window, workspace } from 'vscode';
import { BinanceProvider } from './explorer/binanceProvider';
import BinanceService from './explorer/binanceService';
import { ForexProvider } from './explorer/forexProvider';
import { ForexService } from './explorer/forexService';
import { FundProvider } from './explorer/fundProvider';
import FundService from './explorer/fundService';
import { NewsProvider } from './explorer/newsProvider';
import { StockProvider } from './explorer/stockProvider';
import StockService from './explorer/stockService';
import globalState from './globalState';
import FlashNewsDaemon from './output/flash-news/FlashNewsDaemon';
import FlashNewsOutputServer from './output/flash-news/FlashNewsOutputServer';
import { registerCommandPaletteEvent, registerViewEvent } from './registerCommand';
import { HolidayHelper } from './shared/holidayHelper';
import { LeekFundConfig } from './shared/leekConfig';
import Log from './shared/log';
import { Telemetry } from './shared/telemetry';
import { SortType } from './shared/typed';
import { events, formatDate, isStockTime } from './shared/utils';
import { ProfitStatusBar } from './statusbar/Profit';
import { StatusBar } from './statusbar/statusBar';
import { cacheStocksRemindData } from './webview/leekCenterView';
import { cacheFundAmountData, updateAmount } from './webview/setAmount';
import { cacheStockPriceData } from './shared/stockPriceCache';
import { updateStockPrice } from './webview/setStockPrice';
import { startProxyServer } from './webview/proxyService/proxyService';
import createEastMoneyDataServer from './service/eastmoney';
import { installExtensionHttpProxy, refreshExtensionHttpProxy } from './shared/extensionHttpProxy';

let loopTimer: NodeJS.Timeout | null = null;
let binanceLoopTimer: NodeJS.Timeout | null = null;
let forexLoopTimer: NodeJS.Timeout | null = null;
let fundTreeView: TreeView<any> | null = null;
let stockTreeView: TreeView<any> | null = null;
let forexTreeView: TreeView<any> | null = null;
let binanceTreeView: TreeView<any> | null = null;

let flashNewsOutputServer: FlashNewsOutputServer | null = null;
let profitBar: ProfitStatusBar | null = null;

export async function activate(context: ExtensionContext) {
  globalState.isDevelopment = process.env.NODE_ENV === 'development';
  globalState.context = context;

  /** 扩展自有 HTTP 代理：强制 axios 不走 VS Code 的全局 http.proxy，仅认 panxun.extensionHttpProxy */
  installExtensionHttpProxy();

  const telemetry = new Telemetry();
  globalState.telemetry = telemetry;

  let intervalTimeConfig = LeekFundConfig.getConfig('panxun.interval', 5000);
  let intervalTime = intervalTimeConfig;

  // 节假日，异步会存在延迟判断准确问题，设置成同步影响插件激活速度，暂使用异步
  HolidayHelper.isHolidayInChina().then((isHoliday) => {
    globalState.isHolidayChina = isHoliday;
  });

  setGlobalVariable();
  updateAmount();
  updateStockPrice();

  flashNewsOutputServer = new FlashNewsOutputServer();

  // 初始化选股宝快讯服务
  FlashNewsDaemon.registerServer({
    print: () => {},
    destroy: () => {}
  } as any);

  const fundService = new FundService(context);
  const stockService = new StockService(context);
  const binanceService = new BinanceService(context);
  const forexService = new ForexService(context);

  const nodeFundProvider = new FundProvider(fundService);
  const nodeStockProvider = new StockProvider(stockService);
  const binanceProvider = new BinanceProvider(binanceService);
  const forexProvider = new ForexProvider(forexService);
  const newsProvider = new NewsProvider();

  const statusBar = new StatusBar(stockService, fundService);
  profitBar = new ProfitStatusBar();

  // create fund & stock side views
  fundTreeView = window.createTreeView('panxunView.fund', {
    treeDataProvider: nodeFundProvider,
  });

  stockTreeView = window.createTreeView('panxunView.stock', {
    treeDataProvider: nodeStockProvider,
  });

  binanceTreeView = window.createTreeView('panxunView.binance', {
    treeDataProvider: binanceProvider,
  });

  forexTreeView = window.createTreeView('panxunView.forex', {
    treeDataProvider: forexProvider,
  });

  window.createTreeView('panxunView.news', {
    treeDataProvider: newsProvider,
  });

  // fix when TreeView collapse https://github.com/giscafer/leek-fund/issues/31
  const manualRequest = () => {
    const fundLists = LeekFundConfig.getConfig('panxun.funds') || [];
    fundLists.forEach((value: Array<string>, index: number) => {
      fundService.getData(value, SortType.NORMAL, `fundGroup_${index}`);
    });

    stockService.getData(LeekFundConfig.getConfig('panxun.stocks'), SortType.NORMAL);
  };

  manualRequest();

  // loop
  const loopCallback = () => {
    if (isStockTime()) {
      // 重置定时器
      if (intervalTime !== intervalTimeConfig) {
        intervalTime = intervalTimeConfig;
        setIntervalTime();
        return;
      }

      if (fundTreeView?.visible) {
        // fix https://github.com/giscafer/leek-fund/issues/78
        if (globalState.fundAmountCacheDate !== formatDate(new Date())) {
          updateAmount();
        }
      }
      if (stockTreeView?.visible || fundTreeView?.visible) {
        nodeStockProvider.refresh();
        nodeFundProvider.refresh();
        // statusBar.refresh();
      } else {
        manualRequest();
      }
    } else {
      Log.info('StockMarket Closed! Polling closed!');
      // 闭市时增加轮询间隔时长
      if (intervalTime === intervalTimeConfig) {
        intervalTime = intervalTimeConfig * 100;
        setIntervalTime();
      }
    }
  };

  const setIntervalTime = () => {
    // prevent qps
    if (intervalTime < 3000) {
      intervalTime = 3000;
    }
    if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }

    loopTimer = setInterval(loopCallback, intervalTime);

    /* 虚拟币不休市 */
    if (binanceLoopTimer) {
      clearInterval(binanceLoopTimer);
      binanceLoopTimer = null;
    }
    binanceLoopTimer = setInterval(
      () => {
        if (binanceTreeView?.visible) {
          binanceProvider.refresh();
        }
      },
      // intervalTimeConfig < 3000 ? 3000 : intervalTimeConfig
      300000 // 该功能存在网络问题（一些网络有vpn都无法请求通），这里故意设置长时间
    );

    /* 汇率变化轮询间隔2分钟 */
    if (forexLoopTimer) {
      clearTimeout(forexLoopTimer);
      forexLoopTimer = null;
    }
    forexLoopTimer = setInterval(() => {
      if (forexTreeView?.visible) {
        forexProvider.refresh();
      }
    }, 120000);
  };

  setIntervalTime();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  workspace.onDidChangeConfiguration((e: ConfigurationChangeEvent) => {
    Log.info('Configuration changed');
    if (
      e.affectsConfiguration('panxun.extensionHttpProxy') ||
      e.affectsConfiguration('panxun.extensionHttpProxyBypass')
    ) {
      refreshExtensionHttpProxy();
    }
    intervalTimeConfig = LeekFundConfig.getConfig('panxun.interval');
    setIntervalTime();
    setGlobalVariable();
    statusBar.refresh();
    nodeFundProvider.refresh();
    nodeStockProvider.refresh();
    newsProvider.refresh();
    binanceProvider.refresh();
    forexProvider.refresh();
    flashNewsOutputServer?.reload();
    events.emit('onDidChangeConfiguration');
    profitBar?.reload();
  });

  // register event
  registerViewEvent(
    context,
    fundService,
    stockService,
    nodeFundProvider,
    nodeStockProvider,
    newsProvider,
    flashNewsOutputServer,
    binanceProvider,
    forexProvider
  );

  // register command
  registerCommandPaletteEvent(context, statusBar);

  // start local proxy server
  try {
    await startProxyServer();
  } catch (e) {
    window.showErrorMessage('代理服务启动失败，选股风向标功能可能无法使用。');
    Log.error(`Start Proxy Server Error: ${e}`);
  }
  // start eastmoney data server
  createEastMoneyDataServer();

  // Telemetry Event
  telemetry.sendEvent('activate');
}

function setGlobalVariable() {
  const stockPrice = LeekFundConfig.getConfig('panxun.stockPrice') || {};
  cacheStockPriceData(stockPrice);

  const fundAmount = LeekFundConfig.getConfig('panxun.fundAmount') || {};
  cacheFundAmountData(fundAmount);

  globalState.iconType = LeekFundConfig.getConfig('panxun.iconType') || 'arrow';

  globalState.stockHeldTipShow = LeekFundConfig.getConfig('panxun.stockHeldTipShow') ?? true;

  const stocksRemind = LeekFundConfig.getConfig('panxun.stocksRemind') || {};
  cacheStocksRemindData(stocksRemind);

  globalState.showEarnings = LeekFundConfig.getConfig('panxun.showEarnings');

  globalState.remindSwitch = LeekFundConfig.getConfig('panxun.stockRemindSwitch');

  globalState.kLineChartSwitch = LeekFundConfig.getConfig('panxun.stockKLineChartSwitch');

  globalState.labelFormat = LeekFundConfig.getConfig('panxun.labelFormat');

  globalState.immersiveBackground = LeekFundConfig.getConfig('panxun.immersiveBackground', true);

  globalState.fundGroups = LeekFundConfig.getConfig('panxun.fundGroups') || [];

  const fundLists = LeekFundConfig.getConfig('panxun.funds') || [];
  if (typeof fundLists[0] === 'string' || fundLists[0] instanceof String) {
    // 迁移用户的基金代码到分组模式
    const newFundLists = [fundLists];
    globalState.fundLists = newFundLists;
    LeekFundConfig.setConfig('panxun.funds', newFundLists);
  } else {
    globalState.fundLists = fundLists;
  }
  // 临时解决3.10.1~3.10.3 pr产生的分组bug
  // const leekFundExt = extensions.getExtension('giscafer.panxun');
  // const currentVersion = leekFundExt?.packageJSON?.version;
  // if (compare(currentVersion, '3.9.2', '>=')) {
  // const arr = LeekFundConfig.getConfig('panxun.stocks') || [];
  // const flag = arr.some((a: any) => Array.isArray(a));
  // if (flag) {
  //   const stockList = uniq(compact(flattenDeep(arr)));
  //   Log.info(" ~ setGlobalVariable ~ stockList:", stockList);
  //   LeekFundConfig.setConfig('panxun.stocks', stockList);
  // }

  // }
}

// this method is called when your extension is deactivated
export function deactivate() {
  Log.info('deactivate');
  FlashNewsDaemon.KillAllServer();
  profitBar?.destroy();
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  if (binanceLoopTimer) {
    clearInterval(binanceLoopTimer);
    binanceLoopTimer = null;
  }
}

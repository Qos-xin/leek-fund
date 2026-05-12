import { ViewColumn } from 'vscode';
import { getTemplateFileContent } from '../shared/utils';
import ReusedWebviewPanel from './ReusedWebviewPanel';

function tucaoForum() {
  const panel = ReusedWebviewPanel.create('leek-fund.tucaoForum', '盘讯社区', ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.webview.html = getTemplateFileContent('tucao.html', panel.webview);
}

export default tucaoForum;

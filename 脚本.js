// ==UserScript==
// @name         双人斗地主-撤回插件
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  为斗地主网页注入撤回功能标志
// @match        http://*/*
// @match        https://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

window.__RECALL_SCRIPT_INJECTED = true;

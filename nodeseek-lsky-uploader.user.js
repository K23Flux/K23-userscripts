// ==UserScript==
// @name         NodeSeek 图片上传助手（Lsky 自建图床）
// @namespace    https://lsky.ozoo.top/
// @version      1.0.1
// @description  在 NodeSeek 编辑器中粘贴、拖拽或点图片按钮，自动上传到自己的兰空图床（Lsky Pro V2）
// @author       shuai（原版 NodeImage 图片上传助手），K23Flux 改为 Lsky Pro
// @match        *://www.nodeseek.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @connect      lsky.ozoo.top
// @license      MIT
// @homepageURL  https://github.com/K23Flux/K23-userscripts
// @downloadURL  https://raw.githubusercontent.com/K23Flux/K23-userscripts/main/nodeseek-lsky-uploader.user.js
// @updateURL    https://raw.githubusercontent.com/K23Flux/K23-userscripts/main/nodeseek-lsky-uploader.user.js
// ==/UserScript==

/**
 * 基于「NodeImage图片上传助手」1.0.2（作者 shuai，MIT）改写：
 * 上传目标从 NodeImage 换成自建的 Lsky Pro V2。
 * 默认借用浏览器里图床网页的登录状态（和网页上传走同一个 /upload 接口）；
 * 保存了接口 Token 时改走 /api/v1/upload。
 * 换图床域名时，除了改下面的 DEFAULT_BASE，还要把上面的 @connect 一起改掉。
 */

(() => {
  'use strict';

  const DEFAULT_BASE = 'https://lsky.ozoo.top';

  // ===== 全局配置 =====
  const APP = {
    base: () => (GM_getValue('lsky_base', '') || DEFAULT_BASE).replace(/\/+$/, ''),
    token: GM_getValue('lsky_token', ''),
    strategyId: GM_getValue('lsky_strategy_id', ''),
    sessionOk: null,       // 网页登录状态：null = 还没检查，true = 已登录，false = 没登录
    loginTabOpened: false, // 这个页面是否已经自动打开过图床登录页
    setToken: token => {
      // 兼容用户粘贴时带上了 "Bearer " 前缀
      token = String(token || '').trim().replace(/^Bearer\s+/i, '');
      GM_setValue('lsky_token', token);
      APP.token = token;
      UI.updateState();
    },
    clearToken: () => {
      GM_deleteValue('lsky_token');
      APP.token = '';
      UI.updateState();
    },
    retry: { max: 2, delay: 1000 },
    statusTimeout: 2000
  };

  const SELECTORS = {
    editor: '.CodeMirror',
    toolbar: '.mde-toolbar',
    imgBtn: '.toolbar-item.i-icon.i-icon-pic[title="图片"]',
    container: '#lsky-toolbar-container'
  };

  const STATUS = {
    SUCCESS: { class: 'success', color: '#42d392' },
    ERROR: { class: 'error', color: '#f56c6c' },
    WARNING: { class: 'warning', color: '#e6a23c' },
    INFO: { class: 'info', color: '#0078ff' }
  };

  const MESSAGE = {
    READY: 'Lsky 图床已就绪',
    UPLOADING: '正在上传...',
    UPLOAD_SUCCESS: '上传成功！',
    NEED_LOGIN: '还没登录图床',
    RETRY: (current, max) => `重试上传 (${current}/${max})`
  };

  const DOM = {
    editor: null,
    statusElements: new Set(),
    loginButtons: new Set(),
    getEditor: () => DOM.editor?.CodeMirror
  };

  GM_addStyle(`
    #lsky-status {
      margin-left: 10px;
      display: inline-block;
      font-size: 14px;
      height: 28px;
      line-height: 28px;
      transition: all 0.3s ease;
    }
    #lsky-status.success { color: ${STATUS.SUCCESS.color}; }
    #lsky-status.error { color: ${STATUS.ERROR.color}; }
    #lsky-status.warning { color: ${STATUS.WARNING.color}; }
    #lsky-status.info { color: ${STATUS.INFO.color}; }

    .lsky-login-btn {
      cursor: pointer;
      margin-left: 10px;
      color: ${STATUS.WARNING.color};
      font-size: 14px;
      background: rgba(230, 162, 60, 0.1);
      padding: 3px 8px;
      border-radius: 4px;
      border: 1px solid rgba(230, 162, 60, 0.2);
    }

    .lsky-toolbar-container {
      display: flex;
      align-items: center;
      margin-left: 10px;
    }
  `);

  // ===== 工具函数 =====
  const Utils = {
    waitForElement: selector => new Promise(res => {
      const el = document.querySelector(selector);
      if (el) return res(el);
      new MutationObserver((_, o) => {
        const found = document.querySelector(selector);
        if (found) { o.disconnect(); res(found); }
      }).observe(document.body, { childList: true, subtree: true });
    }),

    isEditingInEditor: () => {
      const a = document.activeElement;
      return a && (a.classList.contains('CodeMirror') || a.closest('.CodeMirror') || a.tagName === 'TEXTAREA');
    },

    createFileInput: cb => {
      const i = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: 'image/*' });
      i.onchange = e => cb([...e.target.files]);
      i.click();
    },

    delay: ms => new Promise(r => setTimeout(r, ms))
  };

  // ===== 与 Lsky Pro 通信 =====
  class ApiError extends Error {
    constructor(message, { status = 0, fatal = false, needLogin = false } = {}) {
      super(message);
      this.status = status;
      this.fatal = fatal;         // true = 重试也没用（没登录、文件被拒等）
      this.needLogin = needLogin; // true = 需要先在浏览器里登录图床
    }
  }

  /** 底层请求。GM_xmlhttpRequest 会自动带上浏览器里图床域名的 Cookie。 */
  const http = ({ url, method = 'GET', data = null, headers = {}, responseType = 'json' }) =>
    new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url, headers, data, responseType,
        timeout: 60000,
        onload: resolve,
        onerror: () => reject(new ApiError('连不上图床')),
        ontimeout: () => reject(new ApiError('请求超时'))
      });
    });

  /** 没登录时图床会把请求跳转到 /login。 */
  const isLoginPage = r => /\/login\/?(?:[?#]|$)/.test(r.finalUrl || '');

  const needLoginError = () => new ApiError(MESSAGE.NEED_LOGIN, { status: 401, fatal: true, needLogin: true });

  /**
   * 解析 Lsky 的返回：{ status: true/false, message: '...', data: {...} }
   * 成功时返回 data；失败时抛 ApiError。
   */
  const parseResult = r => {
    const body = r.response;
    if (r.status === 401 || isLoginPage(r)) throw needLoginError();
    if (r.status === 429) throw new ApiError('请求太频繁，稍后再试', { status: 429, fatal: true });
    if (r.status === 413) throw new ApiError('图片太大，超过服务器限制', { status: 413, fatal: true });
    if (r.status >= 200 && r.status < 300 && body && body.status === true) return body.data;
    if (body && body.status === false) {
      // 图床明确拒绝（超出大小、类型不允许、容量不足等），重试没有意义
      throw new ApiError(body.message || '图床拒绝了这次上传', { status: r.status, fatal: true });
    }
    throw new ApiError(`服务器返回 ${r.status}`, { status: r.status });
  };

  /**
   * 网页登录方式（默认）：借用浏览器里已经登录的图床会话，和在图床网页上传图片走同一个接口。
   * 不需要 Token，也不经手密码。
   */
  const Web = {
    csrf: '',
    checking: null,

    /** 读一次图床的上传页：确认浏览器里已登录，并拿到页面凭证（CSRF）。 */
    refresh: async () => {
      const r = await http({
        url: APP.base() + '/upload',
        headers: { 'Accept': 'text/html' },
        responseType: 'text'
      });
      if (r.status === 401 || isLoginPage(r)) {
        Web.csrf = '';
        APP.sessionOk = false;
        throw needLoginError();
      }
      const html = typeof r.responseText === 'string' ? r.responseText : '';
      const m = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);
      if (r.status >= 400 || !m) throw new ApiError(`读取图床页面失败（${r.status}）`, { status: r.status });
      Web.csrf = m[1];
      APP.sessionOk = true;
      APP.loginTabOpened = false;
      return Web.csrf;
    },

    /** 检查是否已登录，返回 true/false；同时进行的多次检查只发一个请求。 */
    check: () => {
      if (!Web.checking) {
        Web.checking = Web.refresh()
          .then(() => true, error => {
            if (!error.needLogin) console.error('[Lsky]', error);
            return false;
          })
          .finally(() => { Web.checking = null; UI.updateState(); });
      }
      return Web.checking;
    },

    upload: async (formData, retried = false) => {
      if (!Web.csrf) await Web.refresh();
      const r = await http({
        url: APP.base() + '/upload',
        method: 'POST',
        data: formData,
        headers: {
          'Accept': 'application/json',
          'X-CSRF-TOKEN': Web.csrf,
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      if (r.status === 419 && !retried) {
        // 页面凭证过期（登录状态变过），重新读一次再试
        Web.csrf = '';
        return Web.upload(formData, true);
      }
      return parseResult(r);
    }
  };

  /** Token 方式（备用）：保存了接口 Token 时走 /api/v1。 */
  const API = {
    request: async ({ path, method = 'GET', data = null, headers = {}, withAuth = true }) => {
      const r = await http({
        url: APP.base() + '/api/v1' + path,
        method,
        data,
        headers: {
          'Accept': 'application/json',
          ...(withAuth && APP.token ? { 'Authorization': 'Bearer ' + APP.token } : {}),
          ...headers
        }
      });
      return parseResult(r);
    },

    /** 用邮箱和密码换一个 Token（密码只用于这一次请求，不保存）。 */
    createToken: async (email, password) => {
      const data = await API.request({
        path: '/tokens',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ email, password }),
        withAuth: false
      });
      if (!data || !data.token) throw new ApiError('图床没有返回 Token', { fatal: true });
      return data.token;
    },

    /** 验证当前 Token 是否可用，返回用户资料。 */
    profile: () => API.request({ path: '/profile' }),

    uploadImage: async (file, retries = 0) => {
      try {
        const formData = new FormData();
        formData.append('file', file, file.name || 'image.png');
        if (APP.strategyId) formData.append('strategy_id', APP.strategyId);

        const data = APP.token
          ? await API.request({ path: '/upload', method: 'POST', data: formData })
          : await Web.upload(formData);
        const url = data?.links?.url;
        if (!url) throw new ApiError('图床没有返回图片链接', { fatal: true });
        return { url, markdown: `![](${url})` };
      } catch (error) {
        if (error.status === 401 && APP.token) {
          // 保存的 Token 失效了：删掉它，改用网页登录再试
          APP.clearToken();
          return API.uploadImage(file, retries);
        }
        if (error.needLogin) {
          APP.sessionOk = false;
          UI.updateState();
        }
        if (!error.fatal && retries < APP.retry.max) {
          setStatus(STATUS.WARNING.class, MESSAGE.RETRY(retries + 1, APP.retry.max));
          await Utils.delay(APP.retry.delay);
          return API.uploadImage(file, retries + 1);
        }
        throw error;
      }
    }
  };

  // ===== 界面与状态 =====
  const setStatus = (cls, msg, ttl = 0) => {
    DOM.statusElements.forEach(el => { el.className = cls; el.textContent = msg; });
    if (ttl) return Utils.delay(ttl).then(UI.updateState);
  };

  const UI = {
    updateState: () => {
      const ready = Boolean(APP.token) || APP.sessionOk === true;
      const needLogin = !APP.token && APP.sessionOk === false;
      DOM.loginButtons.forEach(btn => { btn.style.display = needLogin ? 'inline-block' : 'none'; });
      DOM.statusElements.forEach(el => {
        if (ready) {
          el.className = STATUS.SUCCESS.class;
          el.textContent = MESSAGE.READY;
        } else {
          el.textContent = '';
        }
      });
    },

    setupToolbar: toolbar => {
      if (!toolbar || toolbar.querySelector(SELECTORS.container)) return;

      const container = document.createElement('div');
      container.id = 'lsky-toolbar-container';
      container.className = 'lsky-toolbar-container';
      toolbar.appendChild(container);

      const imgBtn = toolbar.querySelector(SELECTORS.imgBtn);
      if (imgBtn) {
        const newBtn = imgBtn.cloneNode(true);
        imgBtn.parentNode.replaceChild(newBtn, imgBtn);
        newBtn.addEventListener('click', () => Utils.createFileInput(ImageHandler.handleFiles));
      }

      const statusEl = document.createElement('div');
      statusEl.id = 'lsky-status';
      statusEl.className = STATUS.INFO.class;
      container.appendChild(statusEl);
      DOM.statusElements.add(statusEl);

      const loginBtn = document.createElement('div');
      loginBtn.className = 'lsky-login-btn';
      loginBtn.textContent = '登录图床';
      loginBtn.addEventListener('click', () => Settings.openLogin());
      loginBtn.style.display = 'none';
      container.appendChild(loginBtn);
      DOM.loginButtons.add(loginBtn);

      UI.updateState();
      if (!APP.token && APP.sessionOk === null) Web.check();
    }
  };

  // ===== 设置（油猴菜单） =====
  const Settings = {
    /**
     * 打开图床的登录页。登录完回到 NodeSeek，脚本会自动重新检查。
     * auto = true 表示是上传失败时自动触发的：同一页面只自动开一次标签页。
     */
    openLogin: (auto = false) => {
      if (auto && APP.loginTabOpened) {
        setStatus(STATUS.WARNING.class, '还没登录图床，点右侧「登录图床」');
        return;
      }
      APP.loginTabOpened = true;
      GM_openInTab(APP.base() + '/login', { active: true });
      setStatus(STATUS.WARNING.class, '在新标签页登录图床，然后回到这里重新上传');
    },

    /** 检查登录状态：有 Token 就验证 Token，否则检查浏览器里的网页登录。 */
    verify: async () => {
      if (!APP.token) {
        setStatus(STATUS.INFO.class, '正在检查登录状态...');
        const ok = await Web.check();
        if (ok) await setStatus(STATUS.SUCCESS.class, '已通过网页登录', APP.statusTimeout);
        else if (APP.sessionOk === false) await setStatus(STATUS.ERROR.class, '还没登录图床，点右侧「登录图床」', APP.statusTimeout * 2);
        else await setStatus(STATUS.ERROR.class, '连不上图床', APP.statusTimeout * 2);
        return;
      }
      try {
        setStatus(STATUS.INFO.class, '正在验证 Token...');
        const user = await API.profile();
        await setStatus(STATUS.SUCCESS.class, `Token 可用（${user?.name || user?.email || '已登录'}）`, APP.statusTimeout);
      } catch (error) {
        console.error('[Lsky]', error);
        if (error.status === 401) APP.clearToken();
        await setStatus(STATUS.ERROR.class, `Token 验证失败: ${error.message}`, APP.statusTimeout * 2);
      }
    },

    /** 备用：手动粘贴一个已有的 Token。 */
    promptToken: async () => {
      const input = prompt(`粘贴 ${APP.base()} 的接口 Token（形如 1|xxxxxxxx）：`, '');
      if (input === null || !input.trim()) return;
      APP.setToken(input);
      await Settings.verify();
    },

    /** 备用：用图床账号换一个 Token 存在本机，密码不保存。 */
    loginForToken: async () => {
      const email = prompt(`登录 ${APP.base()}\n图床登录邮箱：`, GM_getValue('lsky_email', ''));
      if (!email) return;
      const password = prompt('图床登录密码（只用于这一次登录，不会保存）：', '');
      if (!password) return;
      try {
        setStatus(STATUS.INFO.class, '正在登录图床...');
        APP.setToken(await API.createToken(email.trim(), password));
        GM_setValue('lsky_email', email.trim());
        await setStatus(STATUS.SUCCESS.class, '登录成功，Token 已保存', APP.statusTimeout);
      } catch (error) {
        console.error('[Lsky]', error);
        const msg = error.status === 401 ? '邮箱或密码不对' : error.message;
        await setStatus(STATUS.ERROR.class, `登录失败: ${msg}`, APP.statusTimeout * 2);
      }
    },

    promptStrategy: () => {
      const input = prompt('存储策略 ID（留空 = 用图床的默认策略）：', APP.strategyId);
      if (input === null) return;
      const value = input.trim();
      if (value && !/^\d+$/.test(value)) { alert('策略 ID 必须是数字'); return; }
      GM_setValue('lsky_strategy_id', value);
      APP.strategyId = value;
    },

    promptBase: () => {
      const input = prompt('图床地址（改成别的域名时，还要把脚本头部的 @connect 一起改）：', APP.base());
      if (input === null) return;
      const value = input.trim().replace(/\/+$/, '');
      if (value && !/^https?:\/\/[^/]+$/.test(value)) { alert('地址格式不对，例如 https://lsky.ozoo.top'); return; }
      GM_setValue('lsky_base', value);
      Web.csrf = '';
      APP.sessionOk = null;
      if (!APP.token) Web.check();
    },

    register: () => {
      GM_registerMenuCommand('检查登录状态', Settings.verify);
      GM_registerMenuCommand('打开图床登录页', () => Settings.openLogin());
      GM_registerMenuCommand('备用：用邮箱密码获取 Token', Settings.loginForToken);
      GM_registerMenuCommand('备用：手动粘贴 Token', Settings.promptToken);
      GM_registerMenuCommand('清除 Token（改回网页登录）', () => { APP.clearToken(); Web.check(); });
      GM_registerMenuCommand('设置存储策略 ID', Settings.promptStrategy);
      GM_registerMenuCommand('设置图床地址', Settings.promptBase);
    }
  };

  // ===== 图片处理 =====
  const ImageHandler = {
    handlePaste: e => {
      if (!Utils.isEditingInEditor()) return;

      const dt = e.clipboardData || e.originalEvent?.clipboardData;
      if (!dt) return;

      let files = [];
      if (dt.files && dt.files.length) {
        files = Array.from(dt.files).filter(f => f.type.startsWith('image/'));
      } else if (dt.items && dt.items.length) {
        files = Array.from(dt.items)
          .filter(i => i.kind === 'file' && i.type.startsWith('image/'))
          .map(i => i.getAsFile())
          .filter(Boolean);
      }

      if (files.length) {
        e.preventDefault();
        e.stopPropagation();
        ImageHandler.handleFiles(files);
      }
    },

    handleFiles: files => {
      files.filter(file => file?.type.startsWith('image/'))
        .forEach(ImageHandler.uploadAndInsert);
    },

    uploadAndInsert: async file => {
      setStatus(STATUS.INFO.class, MESSAGE.UPLOADING);
      try {
        const result = await API.uploadImage(file);
        ImageHandler.insertMarkdown(result.markdown);
        await setStatus(STATUS.SUCCESS.class, MESSAGE.UPLOAD_SUCCESS, APP.statusTimeout);
      } catch (error) {
        console.error('[Lsky]', error);
        if (error.needLogin) { Settings.openLogin(true); return; }
        await setStatus(STATUS.ERROR.class, `上传失败: ${error.message}`, APP.statusTimeout * 2);
      }
    },

    insertMarkdown: markdown => {
      const cm = DOM.getEditor();
      if (cm) {
        const cursor = cm.getCursor();
        cm.replaceRange(`\n${markdown}\n`, cursor);
      }
    }
  };

  // ===== 初始化 =====
  const init = () => {
    Settings.register();

    document.addEventListener('paste', ImageHandler.handlePaste);

    // 在别的标签页登录完图床、切回来时，自动重新检查登录状态
    window.addEventListener('focus', () => {
      if (!APP.token && APP.sessionOk !== true && document.querySelector(SELECTORS.container)) Web.check();
    });

    Utils.waitForElement(SELECTORS.editor).then(editor => {
      DOM.editor = editor;

      editor.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });

      editor.addEventListener('drop', e => {
        e.preventDefault();
        ImageHandler.handleFiles(Array.from(e.dataTransfer.files));
      });
    });

    Utils.waitForElement(SELECTORS.toolbar).then(UI.setupToolbar);

    // NodeSeek 是单页应用，切换页面后工具栏会重建，需要重新注入
    const observer = new MutationObserver(() => {
      const editor = document.querySelector(SELECTORS.editor);
      if (editor && editor !== DOM.editor) DOM.editor = editor;
      const toolbar = document.querySelector(SELECTORS.toolbar);
      if (toolbar && !toolbar.querySelector(SELECTORS.container)) {
        UI.setupToolbar(toolbar);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });

    document.addEventListener('click', e => {
      if (e.target.closest('.tab-option')) {
        setTimeout(() => {
          const toolbar = document.querySelector(SELECTORS.toolbar);
          if (toolbar && !toolbar.querySelector(SELECTORS.container)) {
            UI.setupToolbar(toolbar);
          }
        }, 100);
      }
    });
  };

  window.addEventListener('load', init);
})();

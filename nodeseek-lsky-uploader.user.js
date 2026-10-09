// ==UserScript==
// @name         NodeSeek 图片上传助手（Lsky 自建图床）
// @namespace    https://lsky.ozoo.top/
// @version      1.0.0
// @description  在 NodeSeek 编辑器中粘贴、拖拽或点图片按钮，自动上传到自己的兰空图床（Lsky Pro V2）
// @author       shuai（原版 NodeImage 图片上传助手），K23Flux 改为 Lsky Pro
// @match        *://www.nodeseek.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      lsky.ozoo.top
// @license      MIT
// @homepageURL  https://github.com/K23Flux/K23-userscripts
// @downloadURL  https://raw.githubusercontent.com/K23Flux/K23-userscripts/main/nodeseek-lsky-uploader.user.js
// @updateURL    https://raw.githubusercontent.com/K23Flux/K23-userscripts/main/nodeseek-lsky-uploader.user.js
// ==/UserScript==

/**
 * 基于「NodeImage图片上传助手」1.0.2（作者 shuai，MIT）改写：
 * 上传目标从 NodeImage 换成自建的 Lsky Pro V2（接口 /api/v1/upload，Bearer Token 认证）。
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
    TOKEN_INVALID: 'Token 无效或已失效',
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
    constructor(message, { status = 0, fatal = false } = {}) {
      super(message);
      this.status = status;
      this.fatal = fatal; // true = 重试也没用（Token 错、文件被拒等）
    }
  }

  const API = {
    /**
     * 通用请求。Lsky 的返回格式：{ status: true/false, message: '...', data: {...} }
     * 成功时返回 data；失败时抛 ApiError。
     */
    request: ({ path, method = 'GET', data = null, headers = {}, withAuth = true }) => {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method,
          url: APP.base() + '/api/v1' + path,
          headers: {
            'Accept': 'application/json',
            ...(withAuth && APP.token ? { 'Authorization': 'Bearer ' + APP.token } : {}),
            ...headers
          },
          data,
          responseType: 'json',
          timeout: 60000,
          onload: r => {
            const body = r.response;
            if (r.status === 401) {
              return reject(new ApiError(MESSAGE.TOKEN_INVALID, { status: 401, fatal: true }));
            }
            if (r.status === 429) {
              return reject(new ApiError('请求太频繁，稍后再试', { status: 429, fatal: true }));
            }
            if (r.status === 413) {
              return reject(new ApiError('图片太大，超过服务器限制', { status: 413, fatal: true }));
            }
            if (r.status >= 200 && r.status < 300 && body && body.status === true) {
              return resolve(body.data);
            }
            if (body && body.status === false) {
              // 图床明确拒绝（超出大小、类型不允许、容量不足等），重试没有意义
              return reject(new ApiError(body.message || '图床拒绝了这次上传', { status: r.status, fatal: true }));
            }
            reject(new ApiError(`服务器返回 ${r.status}`, { status: r.status }));
          },
          onerror: () => reject(new ApiError('连不上图床')),
          ontimeout: () => reject(new ApiError('上传超时'))
        });
      });
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

        const data = await API.request({ path: '/upload', method: 'POST', data: formData });
        const url = data?.links?.url;
        if (!url) throw new ApiError('图床没有返回图片链接', { fatal: true });
        return { url, markdown: `![](${url})` };
      } catch (error) {
        if (error.status === 401) APP.clearToken();
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
      const ready = Boolean(APP.token);
      DOM.loginButtons.forEach(btn => { btn.style.display = ready ? 'none' : 'inline-block'; });
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
        newBtn.addEventListener('click', () => {
          if (!APP.token) { Settings.promptToken(); return; }
          Utils.createFileInput(ImageHandler.handleFiles);
        });
      }

      const statusEl = document.createElement('div');
      statusEl.id = 'lsky-status';
      statusEl.className = STATUS.INFO.class;
      container.appendChild(statusEl);
      DOM.statusElements.add(statusEl);

      const loginBtn = document.createElement('div');
      loginBtn.className = 'lsky-login-btn';
      loginBtn.textContent = '设置图床 Token';
      loginBtn.addEventListener('click', () => Settings.promptToken());
      loginBtn.style.display = 'none';
      container.appendChild(loginBtn);
      DOM.loginButtons.add(loginBtn);

      UI.updateState();
    }
  };

  // ===== 设置（油猴菜单） =====
  const Settings = {
    /** 没有 Token 时的引导：直接粘贴 Token，或留空改用账号密码获取。 */
    promptToken: async () => {
      const input = prompt(
        `粘贴 ${APP.base()} 的接口 Token（形如 1|xxxxxxxx）。\n留空并确定 = 改用邮箱和密码获取一个新 Token。`,
        ''
      );
      if (input === null) return;
      if (input.trim()) {
        APP.setToken(input);
        await Settings.verify();
      } else {
        await Settings.loginForToken();
      }
    },

    loginForToken: async () => {
      const email = prompt('图床登录邮箱：', '');
      if (!email) return;
      const password = prompt('图床登录密码（只用来换 Token，不会保存）：', '');
      if (!password) return;
      try {
        setStatus(STATUS.INFO.class, '正在获取 Token...');
        APP.setToken(await API.createToken(email.trim(), password));
        await setStatus(STATUS.SUCCESS.class, 'Token 已保存', APP.statusTimeout);
      } catch (error) {
        console.error('[Lsky]', error);
        await setStatus(STATUS.ERROR.class, `获取 Token 失败: ${error.message}`, APP.statusTimeout * 2);
      }
    },

    verify: async () => {
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
    },

    register: () => {
      GM_registerMenuCommand('设置 / 更换 Token', Settings.promptToken);
      GM_registerMenuCommand('用邮箱密码获取 Token', Settings.loginForToken);
      GM_registerMenuCommand('验证当前 Token', Settings.verify);
      GM_registerMenuCommand('设置存储策略 ID', Settings.promptStrategy);
      GM_registerMenuCommand('设置图床地址', Settings.promptBase);
      GM_registerMenuCommand('清除 Token', () => APP.clearToken());
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
      if (!APP.token) { Settings.promptToken(); return; }
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

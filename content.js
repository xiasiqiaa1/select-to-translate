/**
 * 选中翻译 (Select-to-Translate) — Chrome 浏览器扩展
 * =================================================
 * 选中网页上的任意文字后，自动弹出翻译弹窗。
 * 翻译 API：MyMemory (免费，无需密钥)
 * 支持：中↔英互译（自动检测文本语言方向）
 *
 * 主要功能：
 * 1. 监听 mouseup 事件 → 捕获选中的文字
 * 2. 调用 MyMemory API 进行翻译
 * 3. 在选中位置弹出固定定位的翻译结果窗口
 * 4. XSS 安全：使用 textContent 而非 innerHTML 渲染用户输入
 * 5. 超时机制：8 秒无响应则提示超时
 * 6. 溢出处理：弹窗最大高度 400px/视口60%，超出可滚动
 * 7. 边界检测：弹窗自动避开屏幕边缘，翻译完成后自动修正位置
 */

// -----------------------------------------------------------
// 当前显示的弹窗引用（全局唯一，新弹窗会替换旧弹窗）
// -----------------------------------------------------------
let currentPopup = null;

/**
 * 翻译完成后修正弹窗垂直位置
 * 如果弹窗底部超出视口，则向上推移至视口内。
 * 解决翻译内容撑高弹窗后底部被裁切的问题。
 *
 * @param {HTMLElement} popup - 翻译弹窗 DOM 元素
 */
function clampPopup(popup) {
  const r = popup.getBoundingClientRect();
  if (r.bottom > window.innerHeight + 5) {
    popup.style.top = Math.max(10, window.innerHeight - r.height - 10) + 'px';
  }
}

// -----------------------------------------------------------
// 全局监听：鼠标松开时检测是否有文字被选中
// -----------------------------------------------------------
document.addEventListener('mouseup', function(e) {
  // 点击发生在弹窗内部（如关闭按钮）时跳过，避免弹窗关闭后又立即重建
  if (e.target.closest('#translation-popup')) return;

  // 延迟 100ms 等待浏览器完成选区状态更新
  setTimeout(() => {
    const selectedText = window.getSelection().toString().trim();
    if (selectedText.length > 0) {
      showTranslationPopup(selectedText, e.clientX, e.clientY);
    }
  }, 100);
});

/**
 * 创建并显示翻译弹窗，执行翻译请求
 *
 * 流程：
 *   appendChild → 估算定位(maxH) → 发起翻译请求 → 渲染结果 → clampPopup 修正位置
 *
 * @param {string} text - 用户选中的文本
 * @param {number} x   - 鼠标松开时的 clientX（相对视口）
 * @param {number} y   - 鼠标松开时的 clientY（相对视口）
 */
async function showTranslationPopup(text, x, y) {
  // ---- 移除旧弹窗 ----
  if (currentPopup) {
    currentPopup.remove();
    currentPopup = null;
  }

  // ---- 构建 DOM ----
  const popup = document.createElement('div');
  popup.id = 'translation-popup';
  popup.innerHTML = `
    <div class="translation-header">
      <span>翻译中...</span>
      <button class="translation-close">×</button>
    </div>
    <div class="translation-content">
      <div class="translation-original"></div>
      <div class="translation-result">正在翻译...</div>
    </div>
  `;
  // 使用 textContent 而非 innerHTML，防止用户选中的 HTML/脚本被执行（XSS 防御）
  popup.querySelector('.translation-original').textContent = text;

  document.body.appendChild(popup);
  currentPopup = popup;

  // ---- 初始定位（使用预估高度 maxH，因为此时内容仅为"翻译中..."） ----
  const popupWidth = 320;
  const maxH = Math.min(400, window.innerHeight * 0.6);
  popup.style.maxHeight = maxH + 'px';
  popup.style.overflowY = 'auto';

  let left = x;
  let top  = y + 15;                         // 默认在选中点下方

  // 水平：超出右边界则向左吸附
  if (left + popupWidth > window.innerWidth) {
    left = window.innerWidth - popupWidth - 10;
  }

  // 垂直：优先放在下方，放不下则翻转到上方，再不行贴近视口底部
  if (top + maxH > window.innerHeight) {
    top = y - maxH - 10;                     // 翻转到上方
  }
  if (top + maxH > window.innerHeight) {
    top = window.innerHeight - maxH - 10;    // 贴近视口底部（兜底）
  }
  if (top < 0) {
    top = 10;                                // 不下于视口顶部
  }

  popup.style.left = left + 'px';
  popup.style.top  = top  + 'px';

  // ---- 关闭按钮 ----
  popup.querySelector('.translation-close').addEventListener('click', () => {
    popup.remove();
    currentPopup = null;
  });

  // ---- 翻译请求 ----
  try {
    // 自动判断语言方向：含中文字符 → 中译英；否则 → 英译中
    const langPair = /[\u4e00-\u9fa5]/.test(text) ? 'zh|en' : 'en|zh';
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langPair}`;

    // AbortController 实现 8 秒超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    const data = await response.json();
    const translated = data.responseData.translatedText;

    // 渲染翻译结果（textContent 安全赋值）
    popup.querySelector('.translation-header span').textContent = '翻译结果';
    popup.querySelector('.translation-result').textContent = translated;
    clampPopup(popup);   // 内容撑高后修正位置
  } catch (error) {
    popup.querySelector('.translation-header span').textContent = '翻译失败';
    popup.querySelector('.translation-result').textContent =
      error.name === 'AbortError' ? '请求超时，请重试' : '请检查网络连接';
    clampPopup(popup);
  }

  // ---- 点击弹窗外部关闭 ----
  document.addEventListener('mousedown', function closePopup(e) {
    if (!popup.contains(e.target)) {
      popup.remove();
      currentPopup = null;
      document.removeEventListener('mousedown', closePopup);
    }
  });
}

/* ==========================================================================
   LynkLLM CE — 对话列表（侧边栏）
   ========================================================================== */
(function (global) {
  'use strict';

  const { $, $$, el, clear, Toast, Popover, Confirm } = UI;

  const List = {
    query: ''
  };

  function T(k, ...a) { return global.I18N.t(k, ...a); }

  /* ---------- 渲染 ---------- */
  function render() {
    const box = $('#convList');
    if (!box) return;
    clear(box);

    const all = Store.getConversations()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const q = List.query.trim().toLowerCase();
    let list = all;
    if (q) {
      list = all.filter(c => {
        const title = (c.title || '').toLowerCase();
        if (title.indexOf(q) >= 0) return true;
        // 附带搜索首条消息，提升命中率
        const first = c.messages.find(m => m.role === 'user');
        return first && String(first.content || '').toLowerCase().indexOf(q) >= 0;
      });
    }

    if (!list.length) {
      box.appendChild(el('div', { class: 'empty-inline', style: { margin: '14px 6px', border: 'none' } }, [
        el('i', { class: 'bi ' + (q ? 'bi-search' : 'bi-chat-square-text') }),
        el('div', { text: q ? T('searchNoResult') : T('listEmpty') })
      ]));
      return;
    }

    // 分组
    const groups = groupByDate(list);
    groups.forEach(g => {
      if (g.items.length > 1 || groups.length > 1) {
        box.appendChild(el('div', { class: 'conv-group-label', text: g.label }));
      }
      g.items.forEach(c => box.appendChild(buildItem(c)));
    });
  }

  function groupByDate(list) {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = 864e5;
    const buckets = [
      { key: 'today', label: T('today'), items: [] },
      { key: 'yesterday', label: T('yesterday'), items: [] },
      { key: 'week', label: T('last7Days'), items: [] },
      { key: 'month', label: T('last30Days'), items: [] },
      { key: 'older', label: T('earlier'), items: [] }
    ];
    list.forEach(c => {
      const t = c.updatedAt || c.createdAt || 0;
      let idx;
      if (t >= startOfToday) idx = 0;
      else if (t >= startOfToday - day) idx = 1;
      else if (t >= startOfToday - 7 * day) idx = 2;
      else if (t >= startOfToday - 30 * day) idx = 3;
      else idx = 4;
      buckets[idx].items.push(c);
    });
    return buckets.filter(b => b.items.length);
  }

  function buildItem(conv) {
    const isActive = conv.id === Chat.convId;
    const item = el('div', {
      class: 'conv-item' + (isActive ? ' active' : ''),
      dataset: { id: conv.id },
      role: 'button',
      tabindex: '0'
    });

    item.appendChild(el('i', { class: 'conv-item-icon bi bi-chat-square-text' }));

    const title = conv.title || T('untitled');
    const metaBits = [I18N.formatTime(conv.updatedAt || conv.createdAt)];
    if (conv.messages.length) metaBits.push(T('msgCount', conv.messages.length));
    if (conv.id === Chat.convId) {
      const m = Store.getModel(conv.modelId);
      if (m) metaBits.push(m.name);
    }

    const body = el('div', { class: 'conv-item-body' }, [
      el('div', { class: 'conv-item-title', text: title, title }),
      el('div', { class: 'conv-item-meta', text: metaBits.join(' · ') })
    ]);
    item.appendChild(body);

    const actions = el('div', { class: 'conv-item-actions' });

    const btnMore = el('button', {
      class: 'icon-btn tiny', type: 'button', title: T('more'), 'aria-label': T('more')
    }, [el('i', { class: 'bi bi-three-dots-vertical' })]);
    btnMore.addEventListener('click', e => {
      e.stopPropagation();
      openMorePopover(btnMore, conv);
    });
    actions.appendChild(btnMore);

    item.appendChild(actions);

    item.addEventListener('click', () => Chat.setConversation(conv.id));
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); Chat.setConversation(conv.id); }
    });

    return item;
  }

  /* ---------- 重命名（内联输入） ---------- */
  function openRenamePopover(anchor, conv) {
    const box = el('div');
    box.appendChild(el('div', { class: 'popover-label', text: T('rename') }));
    const input = el('input', {
      class: 'input', type: 'text', value: conv.title || '',
      style: { margin: '4px 4px 8px', width: 'calc(100% - 8px)' },
      placeholder: T('untitled')
    });
    box.appendChild(input);

    const row = el('div', { style: { display: 'flex', gap: '6px', padding: '0 4px 4px' } });
    const btnOk = el('button', { class: 'btn primary sm', type: 'button', text: T('save'), style: { flex: '1' } });
    const btnCancel = el('button', { class: 'btn sm', type: 'button', text: T('cancel'), style: { flex: '1' } });
    row.appendChild(btnOk);
    row.appendChild(btnCancel);
    box.appendChild(row);

    function commit() {
      const v = input.value.trim();
      if (!v) return;
      const fresh = Store.getConversation(conv.id);
      if (!fresh) return;
      fresh.title = v;
      fresh.titleAuto = false;
      Store.upsertConversation(fresh);
      Popover.close();
      render();
      if (global.App) App.onConversationChanged();
      Toast.success(T('renamed'));
    }

    btnOk.addEventListener('click', commit);
    btnCancel.addEventListener('click', () => Popover.close());
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); Popover.close(); }
      e.stopPropagation();
    });

    Popover.open(anchor, box, { align: 'end', width: 240 });
    setTimeout(() => { input.focus(); input.select(); }, 40);
  }

  /* ---------- 更多操作 ---------- */
  function openMorePopover(anchor, conv) {
    const box = el('div');

    const mk = (icon, label, cls, fn) => {
      const b = el('button', { class: 'menu-item ' + (cls || ''), type: 'button' }, [
        el('i', { class: 'bi ' + icon }), document.createTextNode(label)
      ]);
      b.addEventListener('click', () => { Popover.close(); fn(); });
      return b;
    };

    box.appendChild(mk('bi-pencil', T('rename'), '', () => {
      // 菜单关闭后，以对话项本身作为锚点弹出重命名输入
      const node = $('.conv-item[data-id="' + conv.id + '"] .conv-item-actions .icon-btn')
        || $('.conv-item[data-id="' + conv.id + '"]');
      if (node) setTimeout(() => openRenamePopover(node, conv), 0);
    }));

    const copyLabel = global.I18N.lang === 'en' ? 'Copy title' : '复制标题';
    box.appendChild(mk('bi-clipboard', copyLabel, '', () => {
      UI.copyText(conv.title || T('untitled'));
    }));

    const exportLabel = global.I18N.lang === 'en' ? 'Export chat' : '导出该对话';
    box.appendChild(mk('bi-box-arrow-up', exportLabel, '', () => {
      exportConversation(conv);
    }));

    box.appendChild(el('div', { class: 'popover-sep' }));

    box.appendChild(mk('bi-trash3', T('delete'), 'danger', () => deleteConversation(conv)));

    Popover.open(anchor, box, { align: 'end' });
  }

  function exportConversation(conv) {
    const blob = new Blob([JSON.stringify({
      app: 'LynkLLM CE',
      type: 'conversation',
      exportedAt: new Date().toISOString(),
      conversation: conv
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', {
      href: url,
      download: (conv.title || 'conversation').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) + '.json'
    });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 300);
    Toast.success(T('exported'));
  }

  function deleteConversation(conv) {
    const prefs = Store.getConfirmPrefs();
    const doDelete = () => {
      // 一并清理该对话生成的图片（存在 IndexedDB 中，不清理会一直占用空间）
      if (global.ImageStore) {
        const ids = [];
        (conv.messages || []).forEach(m => {
          if (Array.isArray(m.images)) m.images.forEach(i => { if (i && i.id) ids.push(i.id); });
        });
        if (ids.length) ImageStore.removeMany(ids);
      }

      Store.deleteConversation(conv.id);
      const remaining = Store.getConversations()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (Chat.convId === conv.id) {
        if (remaining.length) Chat.setConversation(remaining[0].id);
        else {
          Chat.convId = '';
          Store.setActiveId('');
          Chat.renderMessages();
          if (global.App) App.onConversationChanged();
        }
      }
      render();
      Toast.success(T('convDeleted'));
    };

    if (prefs.deleteConversation) { doDelete(); return; }

    Confirm.ask({
      title: T('deleteConvTitle'),
      text: T('deleteConvText', conv.title || T('untitled')),
      okText: T('delete'),
      noAskKey: 'deleteConversation'
    }).then(r => {
      if (!r.confirmed) return;
      if (r.noAsk && r.noAsk.value) Store.setConfirmPref(r.noAsk.key, true);
      doDelete();
    });
  }

  /* ---------- 事件 ---------- */
  function bind() {
    const input = $('#searchInput');
    const clearBtn = $('#btnClearSearch');

    if (input) {
      const onInput = UI.debounce(() => {
        List.query = input.value;
        if (clearBtn) clearBtn.hidden = !input.value;
        render();
      }, 150);
      input.addEventListener('input', onInput);
      input.addEventListener('search', onInput);
      input.addEventListener('keydown', e => {
        if (e.key === 'Escape') { input.value = ''; List.query = ''; render(); if (clearBtn) clearBtn.hidden = true; }
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (input) input.value = '';
        List.query = '';
        clearBtn.hidden = true;
        render();
        if (input) input.focus();
      });
    }

    const btnNew = $('#btnNewChat');
    if (btnNew) btnNew.addEventListener('click', () => {
      // 新对话先不写入列表，等用户发出第一条消息后再出现
      Chat.startNewChat();
      const ta = $('#input');
      if (ta) ta.focus();
      App.closeSidebarOnMobile();
    });
  }

  List.render = render;
  List.bind = bind;
  List.deleteConversation = deleteConversation;

  global.ConvList = List;
})(window);

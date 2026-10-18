/**
 * Browser half of the session-trash bundle.
 *
 * Registers three additive surfaces:
 *  - a destructive row in one Session's "..." menu;
 *  - a small recycle-bin button beside Settings;
 *  - the `shell.overlay` dialogs (delete confirmation, recycle bin) and the
 *    post-delete notice with an immediate undo.
 *
 * All durable work runs in the Host half over the `/session-trash-api` HTTP
 * route, which enforces the same Host/Origin and browser-credential checks as
 * every other `/api` request; this module only renders and calls it.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-delete-session',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    let Toast
    let IconWarningOutlineRegular
    try {
      // The archive UI uses the same primitive. Keep the delete action usable
      // (with a plain fallback notice) if a future DSH build moves this module.
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      Toast = typeof primitives.Toast === 'function' ? primitives.Toast : undefined
      IconWarningOutlineRegular = typeof primitives.IconWarningOutlineRegular === 'function'
        ? primitives.IconWarningOutlineRegular
        : undefined
    } catch {
      Toast = undefined
      IconWarningOutlineRegular = undefined
    }
    const NS = 'session-trash'

    const zh = {
      'menu.delete': '删除对话',
      'dialog.title': '删除对话',
      'dialog.desc': '确定要删除“{title}”吗？删除后会立即从列表移除，并在回收站保留 {days} 天。期间可以恢复，逾期将永久删除。',
      'dialog.cancel': '取消',
      'dialog.confirm': '删除',
      'dialog.deleting': '正在删除…',
      'toast.deleted': '会话已删除，可',
      'toast.deletedEmpty': '空会话已删除',
      'toast.undo': '撤销',
      'toast.restored': '会话已恢复',
      'trash.title': '已删除的对话',
      'trash.subtitle': '保留最近 {days} 天，期间可以随时恢复。',
      'trash.empty': '回收站是空的',
      'trash.loading': '正在加载…',
      'trash.meta': '删除于 {time} · 剩余 {days} 天 · {size}',
      'trash.restore': '恢复',
      'trash.restoring': '恢复中…',
      'trash.purge': '彻底删除',
      'trash.purgeConfirm': '确认永久删除这条对话？此操作无法撤销。',
      'trash.purgeYes': '永久删除',
      'trash.cancel': '取消',
      'trash.close': '关闭',
      'trash.failed': '操作失败：{message}',
      'footer.label': '已删除的对话',
      'untitled': '未命名对话',
      'error.bad-id': '无效的对话 ID',
      'error.not-found': '找不到这个对话，它可能已经被删除了',
      'error.no-entry': '回收站里没有这个对话，可能已经恢复或已过期',
      'error.conflict': '原位置已存在同名对话数据，已取消恢复',
      'error.lost-data': '回收站中的对话数据已丢失，无法恢复',
      'error.connection': '无法连接到 DSH 服务',
      'error.busy': '这个对话仍在使用中，请稍候重试',
      'error.running': '这个对话仍在运行中，请先停止任务再删除',
      'error.archive-failed': '无法归档这个对话，删除已取消',
      'error.detach-failed': '无法从工作区移除这个对话，删除已取消',
      'error.flush-failed': '无法写入会话日志，删除已取消',
      'error.request': '请求失败',
    }

    const en = {
      'menu.delete': 'Delete session',
      'dialog.title': 'Delete session',
      'dialog.desc': 'Delete “{title}”? It will disappear from the list immediately and stay in the recycle bin for {days} days. You can restore it during that window; after it expires the copy is removed permanently.',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete',
      'dialog.deleting': 'Deleting…',
      'toast.deleted': 'Session deleted. You can ',
      'toast.deletedEmpty': 'Blank session deleted',
      'toast.undo': 'undo',
      'toast.restored': 'Session restored',
      'trash.title': 'Deleted sessions',
      'trash.subtitle': 'Kept for the last {days} days; restore any of them before it expires.',
      'trash.empty': 'The recycle bin is empty',
      'trash.loading': 'Loading…',
      'trash.meta': 'Deleted {time} · {days} days left · {size}',
      'trash.restore': 'Restore',
      'trash.restoring': 'Restoring…',
      'trash.purge': 'Delete permanently',
      'trash.purgeConfirm': 'Delete this session permanently? This cannot be undone.',
      'trash.purgeYes': 'Delete permanently',
      'trash.cancel': 'Cancel',
      'trash.close': 'Close',
      'trash.failed': 'Action failed: {message}',
      'footer.label': 'Deleted sessions',
      'untitled': 'Untitled session',
      'error.bad-id': 'Invalid session ID',
      'error.not-found': 'This session no longer exists',
      'error.no-entry': 'This session is not in the recycle bin; it may already be restored or expired',
      'error.conflict': 'Session data already exists at the original location; restore cancelled',
      'error.lost-data': 'The deleted copy is missing; it cannot be restored',
      'error.connection': 'Cannot reach the DSH service',
      'error.busy': 'This session is still in use; try again in a moment',
      'error.running': 'This session is still running; stop its task before deleting it',
      'error.archive-failed': 'Could not archive this session; deletion was cancelled',
      'error.detach-failed': 'Could not remove this session from its workspace; deletion was cancelled',
      'error.flush-failed': 'Could not write the session log; deletion was cancelled',
      'error.request': 'Request failed',
    }

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set: (next) => {
          if (Object.is(next, value)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.get, store.get)
    }

    function TrashIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: 'false',
        style: { flex: 'none', display: 'block' },
      },
        h('path', { d: 'M2.4 4.4h11.2' }),
        h('path', { d: 'M6.1 4.4V3.1c0-.5.4-.9.9-.9h1.9c.5 0 .9.4.9.9v1.3' }),
        h('path', { d: 'M4.1 4.4l.6 8.4c0 .6.5 1 1 1h4.6c.5 0 1-.4 1-1l.6-8.4' }),
        h('path', { d: 'M6.6 6.9v4.2M9.4 6.9v4.2' })
      )
    }

    function RestoreIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: 'false',
        style: { flex: 'none', display: 'block' },
      },
        h('path', { d: 'M3.2 6.4a5 5 0 1 1 .4 4.1' }),
        h('path', { d: 'M3 3.4v3.1h3.1' })
      )
    }

    const MENU_CSS = `
      .dsh-st-menu-item{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:13px;line-height:18px;text-align:start;cursor:pointer}
      .dsh-st-menu-item:hover,.dsh-st-menu-item:focus-visible{background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 10%,transparent);outline:none}
      .dsh-st-menu-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    `

    const FOOTER_CSS = `
      .dsh-st-footer-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
      .dsh-st-footer-button:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
      .dsh-st-footer-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
    `

    const OVERLAY_CSS = `
      .dsh-st-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,.42);pointer-events:auto}
      .dsh-st-dialog{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;width:min(440px,100%);max-height:min(82vh,640px);padding:20px;border-radius:14px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 24px 64px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary);font:inherit}
      .dsh-st-head{display:flex;align-items:flex-start;gap:12px}
      .dsh-st-head-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
      .dsh-st-title{margin:0;font-size:15px;line-height:22px;font-weight:600}
      .dsh-st-desc{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
      .dsh-st-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px;flex:none}
      .dsh-st-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;padding:7px 14px;cursor:pointer}
      .dsh-st-btn:hover:not(:disabled){background:color-mix(in oklab,var(--dsw-alias-label-primary) 8%,transparent)}
      .dsh-st-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      .dsh-st-btn:disabled{opacity:.55;cursor:default}
      .dsh-st-btn-danger{border-color:color-mix(in oklab,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary)}
      .dsh-st-btn-danger:hover:not(:disabled){background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 12%,transparent)}
      .dsh-st-small{padding:4px 9px;border-radius:7px;font-size:12px;line-height:16px}
      .dsh-st-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;line-height:1;cursor:pointer;flex:none}
      .dsh-st-icon-btn:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
      .dsh-st-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      .dsh-st-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
      .dsh-st-list{display:flex;flex-direction:column;gap:2px;overflow:auto;margin:0 -6px;padding:0 6px;min-height:48px}
      .dsh-st-placeholder{padding:18px 8px;text-align:center;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary)}
      .dsh-st-row{display:flex;align-items:center;gap:10px;padding:8px;border-radius:9px}
      .dsh-st-row:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 6%,transparent)}
      .dsh-st-row-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
      .dsh-st-row-title{font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-st-row-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-st-row-actions{display:flex;align-items:center;gap:4px;flex:none}
    `

    function DeleteMenuItem(props) {
      const { sessionId, displayTitle, requestDelete } = props
      const tr = textOf(props.t, zh)
      const menu = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : undefined
      const setMenuOpen = Array.isArray(menu) ? menu[1] : undefined
      return h(React.Fragment, null,
        h('style', { key: 'style' }, MENU_CSS),
        h('button', {
          key: 'button',
          type: 'button',
          role: 'menuitem',
          className: 'dsh-st-menu-item',
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            if (typeof setMenuOpen === 'function') setMenuOpen(false)
            requestDelete(sessionId, displayTitle)
          },
        },
          h(TrashIcon, { size: 14 }),
          h('span', { className: 'dsh-st-menu-label' }, tr('menu.delete'))
        )
      )
    }

    function TrashFooterButton(props) {
      const tr = textOf(props.t, zh)
      const label = tr('footer.label')
      return h(React.Fragment, null,
        h('style', { key: 'style' }, FOOTER_CSS),
        h('button', {
          key: 'button',
          type: 'button',
          className: 'dsh-st-footer-button',
          title: label,
          'aria-label': label,
          onClick: () => props.openTrash(),
        }, h(TrashIcon, { size: 16 }))
      )
    }

    function TrashOverlay(props) {
      const face = props.face
      const tr = textOf(props.t, zh)
      const stores = face.stores
      const actions = face.actions
      const showNotice = face.showNotice
      const request = useStore(stores.deleteRequest)
      const open = useStore(stores.trashOpen)
      const notice = useStore(stores.notice)
      const listState = useStore(stores.entries)
      const retentionDays = useStore(face.retentionDays)

      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [rowBusy, setRowBusy] = React.useState(null)
      const [confirming, setConfirming] = React.useState(null)
      const cancelRef = React.useRef(null)
      const closeRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) return
        setError(null)
        setConfirming(null)
        void actions.loadTrash()
      }, [open, actions])

      React.useEffect(() => {
        if (request) setError(null)
      }, [request])

      React.useEffect(() => {
        const frame = requestAnimationFrame(() => {
          if (request) {
            cancelRef.current?.focus?.()
          } else if (open) {
            closeRef.current?.focus?.()
          }
        })
        return () => cancelAnimationFrame(frame)
      }, [request, open])

      React.useEffect(() => {
        if (!request && !open) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || busy) return
          if (request) {
            actions.cancelDelete()
            setError(null)
          } else if (open) {
            actions.closeTrash()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [request, open, busy, actions])

      React.useEffect(() => {
        if (Toast !== undefined || !notice) return undefined
        const timer = setTimeout(() => actions.dismissNotice(), 7000)
        return () => clearTimeout(timer)
      }, [notice, actions])

      const deleteTitle = request && (request.title || tr('untitled'))
      const confirmDelete = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          await actions.confirmDelete()
        } catch (reason) {
          setError(errorText(reason, tr))
        } finally {
          setBusy(false)
        }
      }
      const restoreRow = async (sessionId) => {
        if (rowBusy) return
        setRowBusy(sessionId)
        setError(null)
        try {
          await actions.restore(sessionId)
        } catch (reason) {
          setError(errorText(reason, tr))
        } finally {
          setRowBusy(null)
        }
      }
      const purgeRow = async (sessionId) => {
        if (rowBusy) return
        setRowBusy(sessionId)
        setError(null)
        try {
          await actions.purge(sessionId)
          setConfirming(null)
        } catch (reason) {
          setError(errorText(reason, tr))
        } finally {
          setRowBusy(null)
        }
      }
      const undoDelete = async () => {
        try {
          await actions.undoDelete()
        } catch (reason) {
          showNotice({ kind: 'error', message: errorText(reason, tr) })
        }
      }

      const rows = listState.items.map((entry) => {
        const days = Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 86_400_000))
        const title = entry.title || tr('untitled')
        const rowIsBusy = rowBusy === entry.sessionId
        const asking = confirming === entry.sessionId
        return h('div', { key: entry.sessionId, className: 'dsh-st-row' },
          h(RestoreIcon, { size: 14 }),
          h('div', { className: 'dsh-st-row-main' },
            h('div', { className: 'dsh-st-row-title', title }, title),
            h('div', { className: 'dsh-st-row-meta' }, tr('trash.meta', {
              time: new Date(entry.deletedAt).toLocaleString(),
              days: String(days),
              size: formatBytes(entry.bytes),
            }))
          ),
          h('div', { className: 'dsh-st-row-actions' },
            asking
              ? h(React.Fragment, null,
                  h('button', {
                    type: 'button',
                    className: 'dsh-st-btn dsh-st-small dsh-st-btn-danger',
                    disabled: rowIsBusy,
                    title: tr('trash.purgeConfirm'),
                    'aria-label': tr('trash.purgeConfirm'),
                    onClick: () => { void purgeRow(entry.sessionId) },
                  }, tr('trash.purgeYes')),
                  h('button', {
                    type: 'button',
                    className: 'dsh-st-btn dsh-st-small',
                    disabled: rowIsBusy,
                    onClick: () => setConfirming(null),
                  }, tr('trash.cancel'))
                )
              : h(React.Fragment, null,
                  h('button', {
                    type: 'button',
                    className: 'dsh-st-btn dsh-st-small',
                    disabled: rowIsBusy,
                    onClick: () => { void restoreRow(entry.sessionId) },
                  }, rowIsBusy ? tr('trash.restoring') : tr('trash.restore')),
                  h('button', {
                    type: 'button',
                    className: 'dsh-st-btn dsh-st-small',
                    disabled: rowIsBusy,
                    onClick: () => setConfirming(entry.sessionId),
                  }, tr('trash.purge'))
                )
          )
        )
      })

      let listBody
      if (listState.phase === 'loading' && listState.items.length === 0) {
        listBody = h('div', { className: 'dsh-st-placeholder', role: 'status' }, tr('trash.loading'))
      } else if (listState.items.length === 0) {
        listBody = h('div', { className: 'dsh-st-placeholder' }, tr('trash.empty'))
      } else {
        listBody = h('div', { className: 'dsh-st-list' }, rows)
      }

      const toastText = notice === null
        ? ''
        : notice.kind === 'deleted'
          ? (notice.empty === true ? tr('toast.deletedEmpty') : tr('toast.deleted'))
          : notice.kind === 'restored'
            ? tr('toast.restored')
            : tr('trash.failed', { message: notice.message ?? '' })
      const toastActions = notice !== null && notice.kind === 'deleted' && notice.empty !== true
        ? [{ label: tr('toast.undo'), onClick: () => { void undoDelete() } }]
        : []

      return h(React.Fragment, null,
        h('style', { key: 'style' }, OVERLAY_CSS),
        request && h('div', {
          key: 'delete-backdrop',
          className: 'dsh-st-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) {
              actions.cancelDelete()
              setError(null)
            }
          },
        },
          h('div', {
            className: 'dsh-st-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsh-st-delete-title',
          },
            h('h2', { className: 'dsh-st-title', id: 'dsh-st-delete-title' }, tr('dialog.title')),
            h('p', { className: 'dsh-st-desc' }, tr('dialog.desc', {
              title: deleteTitle,
              days: String(retentionDays),
            })),
            error && h('p', { className: 'dsh-st-error', role: 'alert' }, tr('trash.failed', { message: error })),
            h('div', { className: 'dsh-st-actions' },
              h('button', {
                type: 'button',
                className: 'dsh-st-btn',
                ref: cancelRef,
                disabled: busy,
                onClick: () => {
                  if (busy) return
                  actions.cancelDelete()
                  setError(null)
                },
              }, tr('dialog.cancel')),
              h('button', {
                type: 'button',
                className: 'dsh-st-btn dsh-st-btn-danger',
                disabled: busy,
                onClick: () => { void confirmDelete() },
              }, busy ? tr('dialog.deleting') : tr('dialog.confirm'))
            )
          )
        ),
        open && h('div', {
          key: 'trash-backdrop',
          className: 'dsh-st-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) actions.closeTrash()
          },
        },
          h('div', {
            className: 'dsh-st-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsh-st-trash-title',
          },
            h('div', { className: 'dsh-st-head' },
              h('div', { className: 'dsh-st-head-main' },
                h('h2', { className: 'dsh-st-title', id: 'dsh-st-trash-title' }, tr('trash.title')),
                h('p', { className: 'dsh-st-desc' }, tr('trash.subtitle', { days: String(retentionDays) }))
              ),
              h('button', {
                type: 'button',
                className: 'dsh-st-icon-btn',
                ref: closeRef,
                'aria-label': tr('trash.close'),
                title: tr('trash.close'),
                onClick: () => actions.closeTrash(),
              }, '×')
            ),
            error && h('p', { className: 'dsh-st-error', role: 'alert' }, tr('trash.failed', { message: error })),
            listState.error && h('p', { className: 'dsh-st-error', role: 'alert' }, tr('trash.failed', { message: listState.error })),
            listBody,
            h('div', { className: 'dsh-st-actions' },
              h('button', {
                type: 'button',
                className: 'dsh-st-btn',
                onClick: () => actions.closeTrash(),
              }, tr('trash.close'))
            )
          )
        ),
        notice && (Toast !== undefined
          ? h(Toast, {
              key: `dsh-st-notice-${notice.seq ?? 0}`,
              text: toastText,
              onDone: () => actions.dismissNotice(),
              holdMs: 6000,
              ...(notice.kind === 'error'
                ? (IconWarningOutlineRegular !== undefined
                    ? { icon: h(IconWarningOutlineRegular, {}) }
                    : {})
                : { tone: 'success' }),
              ...(toastActions.length > 0 ? { actions: toastActions } : {}),
            })
          : h('div', {
              key: `dsh-st-notice-${notice.seq ?? 0}`,
              role: 'alert',
              style: {
                position: 'fixed',
                top: '40px',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 2147483001,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                maxWidth: 'min(640px, calc(100vw - 48px))',
                padding: '12px 16px',
                borderRadius: '12px',
                background: 'var(--dsw-alias-toast-bg, #1f2329)',
                color: 'var(--dsw-alias-toast-label, #fff)',
                boxShadow: 'var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.24))',
                font: 'inherit',
                fontSize: '14px',
                lineHeight: '22px',
                pointerEvents: 'auto',
              },
            },
              h('span', { style: { minWidth: 0 } }, toastText),
              ...toastActions.map((action) => h('button', {
                key: action.label,
                type: 'button',
                onClick: action.onClick,
                style: {
                  border: 0,
                  background: 'transparent',
                  color: 'var(--dsw-static-deepseek-400, #8ab4ff)',
                  font: 'inherit',
                  cursor: 'pointer',
                  marginInline: '3px',
                  pointerEvents: 'auto',
                },
              }, action.label))
            ))
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale')
        const retentionDays = createStore(7)

        ctx.effect(() => {
          const dispose = locale?.register?.(NS, { zh, en })
          return () => {
            if (typeof dispose === 'function') dispose()
          }
        }, 'session-trash: dictionaries')

        const deleteRequest = createStore(null)
        const trashOpen = createStore(false)
        const notice = createStore(null)
        const entries = createStore({ phase: 'idle', items: [], error: null })
        let noticeSeq = 0
        const showNotice = (value) => {
          notice.set(value === null ? null : { ...value, seq: ++noticeSeq })
        }

        const call = async (method, payload) => {
          let response
          try {
            response = await fetch('/session-trash-api', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ method, payload: payload ?? {} }),
            })
          } catch (reason) {
            const error = new Error(messageOf(reason))
            error.code = 'connection'
            throw error
          }
          if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`)
            error.code = response.status === 401 || response.status === 403 ? 'connection' : 'request'
            throw error
          }
          let result
          try {
            result = await response.json()
          } catch (reason) {
            const error = new Error(messageOf(reason))
            error.code = 'request'
            throw error
          }
          if (!result || result.ok !== true) {
            const error = new Error(result?.error?.message ?? zh['error.request'])
            error.code = String(result?.error?.code ?? 'request').replace(/^session-trash\//, '')
            throw error
          }
          return result.value
        }

        const refreshSessions = () => {
          try {
            const sessions = ctx.get('sessions')
            const pending = sessions?.refresh?.()
            if (pending && typeof pending.catch === 'function') pending.catch(() => {})
          } catch {
            // A refresh failure only delays the list reconciliation; the Host
            // state is already changed.
          }
        }

        const loadTrash = async () => {
          const current = entries.get()
          entries.set({ phase: 'loading', items: current.items, error: null })
          try {
            const value = await call('list')
            entries.set({
              phase: 'ready',
              items: Array.isArray(value?.entries) ? value.entries : [],
              error: null,
            })
          } catch (reason) {
            entries.set({ phase: 'error', items: [], error: messageOf(reason) })
          }
        }

        const retireSession = (sessionId) => {
          try {
            const sessions = ctx.get('sessions')
            if (!sessions || typeof sessions.retireScope !== 'function') return false
            const record = sessions.scopes?.get?.(sessionId)
            if (record === undefined) return false
            // Drop this page's resident scope so the Host can close the agent
            // and the row actually leaves the list instead of falling into the
            // ungrouped bucket as a still-live session.
            sessions.retireScope(sessionId, record)
            refreshSessions()
            return true
          } catch {
            return false
          }
        }
        const sessionIsMain = (sessionId) => {
          try {
            const row = ctx.get('sessions')?.list?.getSnapshot?.().byId?.[sessionId]
            return (row?.retainedBy?.mainView ?? 0) > 0
          } catch {
            return true
          }
        }

        const actions = {
          requestDelete(sessionId, title) {
            deleteRequest.set({
              sessionId,
              title: typeof title === 'string' ? title.slice(0, 200) : '',
            })
          },
          cancelDelete() {
            deleteRequest.set(null)
          },
          async confirmDelete() {
            const request = deleteRequest.get()
            if (request === null) return
            const { sessionId, title } = request
            // The current conversation is cleared by the archive update itself;
            // every other resident scope is retired here so the Host sees the
            // session as closed before it starts copying files.
            if (!sessionIsMain(sessionId)) retireSession(sessionId)
            let value
            try {
              value = await call('delete', { sessionId, title })
            } catch (reason) {
              refreshSessions()
              throw reason
            }
            retireSession(sessionId)
            deleteRequest.set(null)
            refreshSessions()
            showNotice({
              kind: 'deleted',
              sessionId,
              empty: value?.empty === true,
            })
          },
          async undoDelete() {
            const current = notice.get()
            if (!current || current.kind !== 'deleted') return
            showNotice(null)
            await call('restore', { sessionId: current.sessionId })
            refreshSessions()
            void loadTrash()
            showNotice({ kind: 'restored' })
          },
          openTrash() {
            trashOpen.set(true)
          },
          closeTrash() {
            trashOpen.set(false)
          },
          loadTrash,
          async restore(sessionId) {
            await call('restore', { sessionId })
            await loadTrash()
            refreshSessions()
            showNotice({ kind: 'restored' })
          },
          async purge(sessionId) {
            retireSession(sessionId)
            await call('purge', { sessionId })
            refreshSessions()
            await loadTrash()
          },
          dismissNotice() {
            showNotice(null)
          },
        }

        const face = {
          retentionDays,
          stores: { deleteRequest, trashOpen, notice, entries },
          actions,
          showNotice,
        }

        void call('info').then((value) => {
          if (value && Number.isFinite(value.retentionDays) && value.retentionDays > 0) {
            retentionDays.set(value.retentionDays)
          }
        }).catch(() => {})

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'dsh-plugin-delete-session',
          order: 500,
          locale: NS,
          inject: () => ({ requestDelete: actions.requestDelete }),
        }, DeleteMenuItem))

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'session-trash',
          order: 100,
          locale: NS,
          inject: () => ({ openTrash: actions.openTrash }),
        }, TrashFooterButton))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-trash-overlay',
          locale: NS,
          inject: () => ({ face }),
        }, TrashOverlay))
      },
    }
  },
})

function textOf(translate, fallback) {
  return (key, params) => {
    let text
    if (typeof translate === 'function') {
      try {
        text = translate(key, params)
      } catch {
        text = undefined
      }
    }
    if (typeof text !== 'string' || text === key || text.endsWith(`:${key}`)) {
      text = fallback?.[key] ?? key
    }
    if (params === undefined) return text
    return text.replace(/\{(\w+)\}/g, (match, name) => (
      Object.hasOwn(params, name) ? String(params[name]) : match
    ))
  }
}

function messageOf(reason) {
  if (reason instanceof Error) return reason.message
  return String(reason)
}

function errorText(reason, tr) {
  const code = reason && typeof reason === 'object' ? reason.code : undefined
  if (typeof code === 'string' && code !== '' && code !== 'request' && code !== 'session-trash/failed') {
    const key = `error.${code}`
    const text = tr(key)
    if (text !== key) return text
  }
  return messageOf(reason)
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  const digits = value >= 10 || index === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[index]}`
}

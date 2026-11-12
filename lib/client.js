/**
 * dsh-inbox — browser half.
 *
 * 1. Sidebar footer entry「新对话」: POST /api/dsh-inbox/session, wait until the
 *    client session list knows the new id, then open it.
 * 2. Proposal card for `project_propose` tool calls (`tool.call.toolview`):
 *    preview + [Create project] [Modify]; the only path that creates projects.
 *
 * Plain JS, no build step; React comes from the platform module table.
 * Colors come from DSH theme tokens only. Nothing here throws into React.
 */

window.__ModuleLoader__.load({
  id: 'dsh-inbox',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dshInbox'
    const PLUGIN_ID = 'dsh-inbox'
    const TOOL_NAME = 'project_propose'
    const WAIT_MS = 5000
    const API = {
      session: '/api/dsh-inbox/session',
      proposal: '/api/dsh-inbox/proposal',
      create: '/api/dsh-inbox/proposal/create',
      repropose: '/api/dsh-inbox/proposal/repropose',
      opened: '/api/dsh-inbox/proposal/opened',
    }
    const PROPOSAL_RE = /\b(p_[a-z2-7]{26})\b/

    /* ------------------------------------------------------------------ *
     * Strings
     * ------------------------------------------------------------------ */

    const zh = {
      'entry.label': '新对话',
      'entry.title': '新对话（不建项目）',
      'entry.opening': '正在打开…',
      'entry.failed': '打开失败，点击重试',
      'card.title': '项目提议',
      'card.preparing': '正在生成项目预览…',
      'card.loading': '正在读取提议…',
      'card.unavailable': '无法读取提议详情',
      'card.path': '路径',
      'card.files': '将创建',
      'card.brief': 'BRIEF.md 预览',
      'card.agents': 'AGENTS.md 预览',
      'card.kickoff': '新会话预填内容（不会自动发送）',
      'card.warnings': '提示',
      'card.writeAgents': '写入 AGENTS.md',
      'card.create': '创建项目',
      'card.creating': '正在创建…',
      'card.modify': '修改',
      'card.modifyDraft': '我想修改：',
      'card.copied': '已复制到剪贴板，请粘贴到输入框',
      'card.repropose': '按当前草稿重新预览',
      'card.draftChanged': '草稿在预览后被修改过。请先重新预览，确认后再创建。',
      'card.interrupted': '上次创建被中断。',
      'card.continue': '继续创建',
      'card.retry': '重试',
      'card.failed': '创建失败',
      'card.created': '已创建',
      'card.open': '打开项目',
      'card.openFailed': '自动打开失败，请点击「打开项目」',
      'card.workspaceGone': '该项目工作区已被移除：',
      'card.superseded': '已被新的提议替代',
      'card.revision': '第 {n} 版',
      'source.explicit': '你指定的路径',
      'source.common-parent': '按已有项目的共同目录推断',
      'source.recent-parent': '按最近项目的目录推断',
      'source.default-root': '默认项目目录',
      'warn.brief-short': 'brief 较短',
      'warn.brief-missing-goal': '未发现“目标/问题”相关内容',
      'warn.brief-missing-next': '未发现“下一步”相关内容',
      'warn.title-duplicate': '已有同名工作区',
      'warn.path-nested-workspace': '位于已有工作区内部',
    }

    const en = {
      'entry.label': 'New chat',
      'entry.title': 'New chat (no project)',
      'entry.opening': 'Opening…',
      'entry.failed': 'Failed — click to retry',
      'card.title': 'Project proposal',
      'card.preparing': 'Preparing project preview…',
      'card.loading': 'Loading proposal…',
      'card.unavailable': 'Proposal details are unavailable',
      'card.path': 'Path',
      'card.files': 'Creates',
      'card.brief': 'BRIEF.md preview',
      'card.agents': 'AGENTS.md preview',
      'card.kickoff': 'Prefilled first message (not sent automatically)',
      'card.warnings': 'Notes',
      'card.writeAgents': 'Write AGENTS.md',
      'card.create': 'Create project',
      'card.creating': 'Creating…',
      'card.modify': 'Modify',
      'card.modifyDraft': 'I want to change: ',
      'card.copied': 'Copied — paste it into the composer',
      'card.repropose': 'Re-preview current draft',
      'card.draftChanged': 'The draft changed after this preview. Re-preview before creating.',
      'card.interrupted': 'The last attempt was interrupted.',
      'card.continue': 'Continue',
      'card.retry': 'Retry',
      'card.failed': 'Creation failed',
      'card.created': 'Created',
      'card.open': 'Open project',
      'card.openFailed': 'Could not open automatically — click "Open project"',
      'card.workspaceGone': 'The project workspace was removed: ',
      'card.superseded': 'Replaced by a newer proposal',
      'card.revision': 'revision {n}',
      'source.explicit': 'path you gave',
      'source.common-parent': 'inferred from your projects\' common folder',
      'source.recent-parent': 'inferred from your most recent project',
      'source.default-root': 'default projects folder',
      'warn.brief-short': 'brief is short',
      'warn.brief-missing-goal': 'no goal/problem section found',
      'warn.brief-missing-next': 'no next-steps section found',
      'warn.title-duplicate': 'a workspace with this title exists',
      'warn.path-nested-workspace': 'inside an existing workspace',
    }

    /* ------------------------------------------------------------------ *
     * Styles (theme tokens only; prefix dib-)
     * ------------------------------------------------------------------ */

    const CSS = `
.dib-entry{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:32px;padding:0 10px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;font-weight:500;line-height:1;cursor:pointer;white-space:nowrap;flex:0 0 auto;transition:background .15s,color .15s}
.dib-entry:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dib-entry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dib-entry:disabled{cursor:progress;opacity:.75}
.dib-entry.is-icon{width:32px;padding:0}
.dib-entry.is-error{color:var(--dsw-alias-state-error-primary)}
.dib-card{box-sizing:border-box;margin:6px 0;padding:12px 14px;border:1px solid var(--dsw-alias-border-primary, var(--dsw-alias-bg-layer-2));border-radius:12px;background:var(--dsw-alias-bg-layer-1, transparent);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;max-width:100%}
.dib-card.is-muted{opacity:.65}
.dib-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.dib-kicker{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dib-title{font-weight:600;font-size:14px}
.dib-row{display:flex;gap:8px;margin:2px 0;min-width:0}
.dib-key{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.dib-val{min-width:0;overflow-wrap:anywhere}
.dib-mono{font-family:var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:12px}
.dib-note{color:var(--dsw-alias-label-secondary);font-size:12px}
.dib-warn{color:var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary))}
.dib-err{color:var(--dsw-alias-state-error-primary)}
.dib-ok{color:var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary))}
.dib-card details{margin:6px 0}
.dib-card summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}
.dib-pre{margin:6px 0 0;padding:8px 10px;max-height:280px;overflow:auto;white-space:pre-wrap;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.dib-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
.dib-btn{box-sizing:border-box;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-primary, var(--dsw-alias-bg-layer-2));background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer}
.dib-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dib-btn.is-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-brand, #fff)}
.dib-btn.is-primary:hover:not(:disabled){filter:brightness(1.06)}
.dib-btn:disabled{opacity:.6;cursor:progress}
.dib-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dib-check{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}
`

    function InboxIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { key: 'b', d: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 3.5V16h0A2 2 0 0 1 4 14z' }),
        h('path', { key: 'p', d: 'M12 7.5v5M9.5 10h5' }))
    }

    /* ------------------------------------------------------------------ *
     * Helpers
     * ------------------------------------------------------------------ */

    function format(text, vars) {
      return String(text).replace(/\{(\w+)\}/g, (_, key) => (vars && key in vars ? String(vars[key]) : ''))
    }

    function detailOf(error) {
      const text = error instanceof Error ? error.message : String(error ?? '')
      const flat = text.replace(/\s+/g, ' ').trim()
      return flat === '' ? 'unknown error' : flat.length > 240 ? `${flat.slice(0, 237)}…` : flat
    }

    async function api(method, url, body) {
      const response = await fetch(url, {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok) {
        const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`)
        error.code = payload?.error?.code
        error.status = response.status
        throw error
      }
      return payload
    }

    /** Resolve when `predicate(snapshot)` holds, or reject after `ms`. */
    function waitFor(observable, predicate, ms) {
      return new Promise((resolve, reject) => {
        let done = false
        let unsubscribe = () => {}
        const finish = (fn, value) => {
          if (done) return
          done = true
          clearTimeout(timer)
          try { unsubscribe() } catch { /* ignore */ }
          fn(value)
        }
        const check = () => {
          try {
            const value = predicate(observable.getSnapshot())
            if (value) finish(resolve, value)
          } catch (error) {
            finish(reject, error)
          }
        }
        const timer = setTimeout(() => finish(reject, new Error('timeout')), ms)
        try {
          unsubscribe = observable.subscribe(check) ?? (() => {})
        } catch {
          // Without subscribe we still get the first check and the timeout.
        }
        check()
      })
    }

    function workspaceItem(snapshot, workspaceId) {
      const items = Array.isArray(snapshot?.items) ? snapshot.items : []
      return items.find(item => item?.workspaceId === workspaceId)
    }

    function hasSession(snapshot, sessionId) {
      const byId = snapshot?.byId
      if (byId === undefined || byId === null) return false
      return typeof byId.get === 'function' ? byId.get(sessionId) !== undefined : byId[sessionId] !== undefined
    }

    function proposalRef(props) {
      const block = props?.block
      const meta = block?.meta?.dshInbox
      if (meta && typeof meta.proposalId === 'string' && typeof meta.sessionId === 'string') return meta
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined
      const content = Array.isArray(block?.content) ? block.content : []
      for (const part of content) {
        const match = typeof part?.text === 'string' ? PROPOSAL_RE.exec(part.text) : null
        if (match && sessionId) return { sessionId, proposalId: match[1] }
      }
      return undefined
    }

    function errorTextOf(block) {
      const content = Array.isArray(block?.content) ? block.content : []
      const text = content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('\n').trim()
      return text !== '' ? text : block?.error?.reason ?? block?.error?.code ?? 'error'
    }

    /* ------------------------------------------------------------------ *
     * Entry button
     * ------------------------------------------------------------------ */

    function EntryButton({ wide, t, ctx }) {
      const [phase, setPhase] = React.useState('idle')
      const [detail, setDetail] = React.useState('')
      const busy = React.useRef(false)

      const open = async () => {
        if (busy.current) return
        busy.current = true
        setPhase('opening')
        setDetail('')
        try {
          const { sessionId } = await api('POST', API.session, {})
          await waitFor(ctx.sessions.list, snapshot => hasSession(snapshot, sessionId), WAIT_MS).catch(() => undefined)
          ctx.uiWorkspace.openSession(sessionId)
          setPhase('idle')
        } catch (error) {
          console.warn('[dsh-inbox] new chat failed:', error)
          setDetail(detailOf(error))
          setPhase('error')
        } finally {
          busy.current = false
        }
      }

      const opening = phase === 'opening'
      const failed = phase === 'error'
      const label = opening ? t('entry.opening') : failed ? t('entry.failed') : t('entry.label')
      const title = failed ? `${t('entry.failed')}: ${detail}` : t('entry.title')
      return h('button', {
        type: 'button',
        className: `dib-entry${wide ? '' : ' is-icon'}${failed ? ' is-error' : ''}`,
        title,
        'aria-label': title,
        'aria-busy': opening || undefined,
        disabled: opening,
        onClick: open,
      }, h(InboxIcon, { key: 'i', size: wide ? 16 : 18 }), wide ? h('span', { key: 'l' }, label) : null)
    }

    /* ------------------------------------------------------------------ *
     * Proposal card
     * ------------------------------------------------------------------ */

    function ProposalCard(props) {
      const { t, ctx } = props
      const ref = props.phase === 'result' && props.block?.isError !== true ? proposalRef(props) : undefined
      const [view, setView] = React.useState(null)
      const [loadError, setLoadError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(null)
      const [writeAgents, setWriteAgents] = React.useState(true)
      const mounted = React.useRef(true)
      React.useEffect(() => () => { mounted.current = false }, [])

      const load = React.useCallback(async () => {
        if (!ref) return
        try {
          const query = new URLSearchParams({ sessionId: ref.sessionId, proposalId: ref.proposalId })
          const next = await api('GET', `${API.proposal}?${query}`)
          if (mounted.current) { setView(next); setLoadError('') }
        } catch (error) {
          if (mounted.current) setLoadError(detailOf(error))
        }
      }, [ref?.sessionId, ref?.proposalId])

      React.useEffect(() => { void load() }, [load])

      if (props.phase !== 'result') {
        return h('div', { className: 'dib-card is-muted' }, h('span', { className: 'dib-note' }, t('card.preparing')))
      }
      if (props.block?.isError === true) {
        return h('div', { className: 'dib-card' },
          h('div', { className: 'dib-head' }, h('span', { className: 'dib-kicker' }, t('card.title'))),
          h('div', { className: 'dib-err dib-mono' }, errorTextOf(props.block)))
      }
      if (!ref || (view === null && loadError !== '')) {
        return h('div', { className: 'dib-card is-muted' },
          h('div', { className: 'dib-note' }, t('card.unavailable')),
          h('pre', { className: 'dib-pre dib-mono' }, errorTextOf(props.block)))
      }
      if (view === null) {
        return h('div', { className: 'dib-card is-muted' }, h('span', { className: 'dib-note' }, t('card.loading')))
      }

      const body = { sessionId: ref.sessionId, proposalId: ref.proposalId }

      const run = async (name, fn) => {
        if (busy !== '') return
        setBusy(name)
        setMessage(null)
        try {
          await fn()
        } catch (error) {
          console.warn(`[dsh-inbox] ${name} failed:`, error)
          if (mounted.current) setMessage({ kind: 'err', text: detailOf(error) })
        } finally {
          if (mounted.current) setBusy('')
          await load()
        }
      }

      const openProject = async (state) => {
        const workspaces = ctx.workspaces.list
        const item = workspaceItem(workspaces.getSnapshot(), state.workspaceId)
        if (item === undefined) {
          setMessage({ kind: 'err', text: `${t('card.workspaceGone')}${state.path}` })
          return
        }
        const archived = workspaces.getSnapshot()?.archivedSessionIds ?? []
        const sid = state.projectSessionId
        if (typeof sid === 'string' && !archived.includes(sid) && hasSession(ctx.sessions.list.getSnapshot(), sid)) {
          ctx.uiWorkspace.openSession(sid)
          return
        }
        ctx.uiWorkspace.startSession(state.workspaceId)
      }

      const create = () => run('create', async () => {
        const result = await api('POST', API.create, { ...body, writeAgents })
        try {
          await waitFor(ctx.workspaces.list, snapshot => workspaceItem(snapshot, result.workspaceId), WAIT_MS)
        } catch {
          setMessage({ kind: 'err', text: t('card.openFailed') })
          return
        }
        if (result.projectSessionId) {
          await openProject({ ...result, path: result.path })
          return
        }
        ctx.uiWorkspace.startSession(result.workspaceId, { prompt: result.kickoff, whenDraftExists: 'replace' })
        // The new workspace's first session is the kickoff session; remember it for "Open project".
        const item = await waitFor(ctx.workspaces.list, snapshot => {
          const found = workspaceItem(snapshot, result.workspaceId)
          return found && Array.isArray(found.sessionIds) && found.sessionIds.length > 0 ? found : undefined
        }, WAIT_MS).catch(() => undefined)
        const first = item?.sessionIds?.[item.sessionIds.length - 1]
        if (typeof first === 'string') await api('POST', API.opened, { ...body, projectSessionId: first }).catch(() => undefined)
      })

      const repropose = () => run('repropose', async () => {
        await api('POST', API.repropose, body)
      })

      const modify = () => {
        const text = t('card.modifyDraft')
        try {
          const binding = ctx.sessions.binding?.(ref.sessionId)
          const conversation = binding?.ctx?.get?.('conversation')
          if (conversation?.input?.for) {
            const input = conversation.input.for(binding.ctx)
            input.setDraft(text)
            input.focus?.()
            return
          }
        } catch (error) {
          console.warn('[dsh-inbox] prefill failed:', error)
        }
        navigator.clipboard?.writeText?.(text).then(
          () => setMessage({ kind: 'note', text: t('card.copied') }),
          () => setMessage({ kind: 'note', text }),
        )
      }

      const state = view.state
      const muted = state === 'superseded'
      const rows = []
      rows.push(h('div', { key: 'path', className: 'dib-row' },
        h('span', { className: 'dib-key' }, t('card.path')),
        h('span', { className: 'dib-val' },
          h('span', { className: 'dib-mono' }, view.intent?.path ?? view.path),
          view.pathSource ? h('span', { className: 'dib-note' }, ` · ${t(`source.${view.pathSource}`)}`) : null)))
      rows.push(h('div', { key: 'files', className: 'dib-row' },
        h('span', { className: 'dib-key' }, t('card.files')),
        h('span', { className: 'dib-val dib-mono' }, view.files.join('  '))))
      if (Array.isArray(view.warnings) && view.warnings.length > 0) {
        rows.push(h('div', { key: 'warn', className: 'dib-row dib-warn' },
          h('span', { className: 'dib-key' }, t('card.warnings')),
          h('span', { className: 'dib-val' }, view.warnings.map(w => t(`warn.${w}`)).join('；'))))
      }

      const details = state === 'superseded' ? [] : [
        h('details', { key: 'brief' }, h('summary', null, t('card.brief')), h('pre', { className: 'dib-pre dib-mono' }, view.brief)),
        view.agents ? h('details', { key: 'agents' }, h('summary', null, t('card.agents')), h('pre', { className: 'dib-pre dib-mono' }, view.agents)) : null,
        h('details', { key: 'kickoff' }, h('summary', null, t('card.kickoff')), h('pre', { className: 'dib-pre dib-mono' }, view.kickoff)),
      ]

      const btn = (key, label, onClick, primary, disabled) => h('button', {
        key, type: 'button', className: `dib-btn${primary ? ' is-primary' : ''}`, onClick, disabled: disabled || busy !== '',
      }, busy === key ? t('card.creating') : label)

      const actions = []
      let status = null
      const canEdit = state === 'proposed' || (state === 'failed' && !view.intent)
      if (state === 'proposed' && view.draftChanged) {
        status = h('div', { className: 'dib-warn' }, t('card.draftChanged'))
        actions.push(btn('repropose', t('card.repropose'), repropose, true))
        actions.push(btn('modify', t('card.modify'), modify, false))
      } else if (state === 'proposed') {
        if (view.agents) {
          actions.push(h('label', { key: 'agents', className: 'dib-check' },
            h('input', { type: 'checkbox', checked: writeAgents, onChange: e => setWriteAgents(e.target.checked) }), t('card.writeAgents')))
        }
        actions.push(btn('create', t('card.create'), create, true))
        actions.push(btn('modify', t('card.modify'), modify, false))
      } else if (state === 'creating' && view.interrupted) {
        status = h('div', { className: 'dib-warn' }, t('card.interrupted'))
        actions.push(btn('create', t('card.continue'), create, true))
      } else if (state === 'creating') {
        status = h('div', { className: 'dib-note' }, t('card.creating'))
      } else if (state === 'failed') {
        status = h('div', { className: 'dib-err' }, `${t('card.failed')}: ${view.error?.message ?? ''}`)
        if (view.draftChanged && canEdit) actions.push(btn('repropose', t('card.repropose'), repropose, true))
        else actions.push(btn('create', t('card.retry'), create, true))
        if (canEdit) actions.push(btn('modify', t('card.modify'), modify, false))
      } else if (state === 'created') {
        status = h('div', { className: 'dib-ok' }, `${t('card.created')} · ${view.title}`)
        actions.push(btn('open', t('card.open'), () => { openProject(view).catch(error => setMessage({ kind: 'err', text: detailOf(error) })) }, true))
      } else if (state === 'superseded') {
        status = h('div', { className: 'dib-note' }, t('card.superseded'))
      }

      return h('div', { className: `dib-card${muted ? ' is-muted' : ''}`, 'data-dsh-inbox-proposal': ref.proposalId },
        h('div', { className: 'dib-head' },
          h('span', { className: 'dib-kicker' }, t('card.title')),
          h('span', { className: 'dib-title' }, view.title),
          view.revision > 1 ? h('span', { className: 'dib-note' }, format(t('card.revision'), { n: view.revision })) : null),
        state === 'superseded' ? null : rows,
        details,
        status,
        message ? h('div', { className: message.kind === 'err' ? 'dib-err' : 'dib-note' }, message.text) : null,
        actions.length > 0 ? h('div', { className: 'dib-actions' }, actions) : null)
    }

    /* ------------------------------------------------------------------ *
     * Registration
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-plugin', PLUGIN_ID)
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-inbox: stylesheet')

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-inbox: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: PLUGIN_ID,
        order: 5,
        locale: NS,
        label: () => t('entry.label'),
      }, function InboxEntry(props) {
        return h(EntryButton, { wide: props?.wide === true, t, ctx })
      }))

      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview',
        key: TOOL_NAME,
      }, function InboxProposalCard(props) {
        return h(ProposalCard, { ...props, t, ctx })
      }))
    }

    return { inject: ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace'], apply, __test: { proposalRef, waitFor, hasSession, workspaceItem, zh, en } }
  },
})

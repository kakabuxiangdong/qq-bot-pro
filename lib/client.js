// qq-bot-pro 的浏览器半侧：在「设置 → 插件」里给这个插件加一个图形设置页。
//
// 形状是 dsh 客户端加载器要的样子（交给 window.__ModuleLoader__ 的闭包，require 只回答共享模块）。
// 它只做两件事：向 /x-qq-bot-pro/settings 读写设置、把开关画出来。
// 绝不允许抛错：客户端插件一旦抛错，整个 Web UI 白屏。
window.__ModuleLoader__.load({ id: 'qq-bot-pro', factory: (require) => {
  const module = { exports: {} }
  const React = require('react')
  const h = React.createElement
  const API = '/x-qq-bot-pro'

  const S = {
    wrap: { maxWidth: 760, fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' },
    intro: { margin: '0 0 10px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
    group: { margin: '18px 0 6px', fontSize: 13, fontWeight: 600 },
    hint: { margin: '0 0 8px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
    row: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '7px 0', borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { fontSize: 13 },
    rowHelp: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginTop: 1 },
    input: { width: 96, padding: '3px 6px', fontSize: 12, borderRadius: 6, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit' },
    wide: { width: 260, padding: '3px 6px', fontSize: 12, borderRadius: 6, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit' },
    bar: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 18 },
    btn: { padding: '5px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer', border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit' },
    btnPrimary: { padding: '5px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer', border: '0.5px solid transparent', background: 'var(--dsw-alias-state-business-primary, #4d6bfe)', color: '#fff' },
    status: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
    code: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 14, wordBreak: 'break-all' },
    pre: { fontSize: 11, lineHeight: 1.35, maxHeight: 260, overflow: 'auto', padding: 8, marginTop: 8, borderRadius: 6, background: 'rgba(127,127,127,0.08)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
    textarea: { width: '100%', boxSizing: 'border-box', minHeight: 110, padding: '6px 8px', fontSize: 12, lineHeight: 1.5, borderRadius: 6, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', resize: 'vertical', fontFamily: 'inherit' },
  }

  const FEATURE_TITLES = {
    stickerBridge: '表情包发送',
    stickerTools: '表情包工具',
    memory: '长期记忆',
    groupHistory: '群聊存档',
    crossScope: '群聊 / 私聊互通',
    proactive: '冷场主动发言',
    proactiveGroup: '群里主动开口',
    proactiveC2c: '私聊主动开口',
    archiveGuard: '归档看守',
  }

  function fetchJSON(url, options) {
    return fetch(url, Object.assign({ credentials: 'same-origin' }, options)).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status))
        return body
      })
    })
  }

  function Toggle(props) {
    return h('label', { style: S.row },
      h('input', {
        type: 'checkbox',
        checked: props.checked,
        disabled: props.disabled,
        onChange: function (e) { props.onChange(e.target.checked) },
        style: { marginTop: 3 },
      }),
      h('span', { style: S.rowText },
        h('div', { style: S.rowTitle }, props.title),
        props.help ? h('div', { style: S.rowHelp }, props.help) : null,
      ),
    )
  }

  function SettingsPage() {
    const [data, setData] = React.useState(null)
    const [draft, setDraft] = React.useState({ features: {}, gate: {}, persona: {} })
    const [status, setStatus] = React.useState('')
    const [saving, setSaving] = React.useState(false)
    const [logLines, setLogLines] = React.useState(null)

    React.useEffect(function () {
      let alive = true
      fetchJSON(API + '/settings').then(function (body) {
        if (alive) { setData(body); setStatus('') }
      }, function (e) {
        if (alive) setStatus('读取设置失败：' + (e && e.message ? e.message : e))
      })
      return function () { alive = false }
    }, [])

    if (!data) {
      return h('div', { style: S.wrap },
        h('p', { style: S.intro }, 'QQ 机器人插件设置'),
        h('p', { style: S.status }, status || '加载中…'))
    }

    const features = Object.assign({}, data.features, draft.features)
    const gate = Object.assign({}, data.gate, draft.gate)
    const persona = Object.assign({}, data.persona || {}, draft.persona)
    const dirty = Object.keys(draft.features).length > 0 || Object.keys(draft.gate).length > 0 || Object.keys(draft.persona).length > 0

    const setFeature = function (key) {
      return function (value) {
        setDraft(function (d) { return { features: Object.assign({}, d.features, { [key]: value }), gate: d.gate, persona: d.persona } })
      }
    }
    const setGate = function (key) {
      return function (value) {
        setDraft(function (d) { return { features: d.features, gate: Object.assign({}, d.gate, { [key]: value }), persona: d.persona } })
      }
    }
    const setPersona = function (key) {
      return function (value) {
        setDraft(function (d) { return { features: d.features, gate: d.gate, persona: Object.assign({}, d.persona, { [key]: value }) } })
      }
    }

    const save = function () {
      setSaving(true)
      setStatus('保存中…')
      fetchJSON(API + '/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features: draft.features, gate: draft.gate, persona: draft.persona }),
      }).then(function (body) {
        setData(body)
        setDraft({ features: {}, gate: {}, persona: {} })
        setStatus(body.changed ? '已保存（' + body.changed + ' 项），立即生效' : '没有改动')
      }, function (e) {
        setStatus('保存失败：' + (e && e.message ? e.message : e))
      }).then(function () { setSaving(false) })
    }
    const loadLog = function () {
      fetchJSON(API + '/log').then(function (body) { setLogLines(body.lines || []) }, function (e) {
        setStatus('读取日志失败：' + (e && e.message ? e.message : e))
      })
    }

    const featureRows = (data.order.features || Object.keys(data.features)).map(function (key) {
      return h(Toggle, {
        key: 'f-' + key,
        title: FEATURE_TITLES[key] || key,
        help: key === 'proactive' ? '总开关：关掉后群里和私聊都不会主动开口' : null,
        checked: features[key] !== false,
        disabled: saving,
        onChange: setFeature(key),
      })
    })

    const gateKeys = ['answerAll', 'replyToName', 'replyToQuote', 'replyToFollowUp', 'skipWhenMentioningOthers', 'mergeBurst']
    const gateRows = gateKeys.map(function (key) {
      return h(Toggle, {
        key: 'g-' + key,
        title: (data.help.gate && data.help.gate[key]) ? data.help.gate[key].split('（')[0] : key,
        help: (data.help.gate && data.help.gate[key] && data.help.gate[key].indexOf('（') >= 0)
          ? data.help.gate[key].slice(data.help.gate[key].indexOf('（'))
          : null,
        checked: gate[key] === true,
        disabled: saving,
        onChange: setGate(key),
      })
    })

    const minutes = function (ms) { return Math.round(Number(ms) / 60000) }
    const numField = function (key, label, toValue, fromValue, suffix) {
      return h('label', { key: 'n-' + key, style: S.row },
        h('span', { style: S.rowText }, h('div', { style: S.rowTitle }, label)),
        h('input', {
          type: 'number',
          min: 1,
          style: S.input,
          disabled: saving,
          value: toValue(gate[key]),
          onChange: function (e) { setGate(key)(fromValue(e.target.value)) },
        }),
        h('span', { style: S.status }, suffix),
      )
    }

    const personaField = function (key, title, help, placeholder) {
      return h('div', { key: 'p-' + key, style: { margin: '10px 0 16px' } },
        h('div', { style: S.rowTitle }, title),
        h('div', { style: S.rowHelp }, help),
        h('textarea', {
          style: S.textarea,
          disabled: saving,
          value: persona[key] || '',
          placeholder: placeholder,
          onChange: function (e) { setPersona(key)(e.target.value) },
        }),
      )
    }

    return h('div', { style: S.wrap },
      h('p', { style: S.intro },
        '这里是给 QQ 官方机器人通道补的能力。改完点保存，2 秒内生效，不用重启。',
        data.live && data.live.runtime ? '（宿主已连上 QQ）' : '（宿主还没连上 QQ，看到的是保存下来的配置）'),

      h('div', { style: S.group }, '功能开关'),
      featureRows,

      h('div', { style: S.group }, '什么时候回消息'),
      h('p', { style: S.hint }, '群里不 @ 她时，靠下面这些规则决定要不要接话；关掉全部就只回 @ 和私聊。'),
      gateRows,

      h('div', { style: S.group }, '细节'),
      numField('followWindowMs', '接话窗口：她说完话后多久内，别人的话算「接着说」', minutes, function (v) { return Math.max(1, Number(v) || 5) * 60000 }, '分钟'),
      numField('quoteWindowMs', '引用窗口：她说过的话多久内被引用还算数', minutes, function (v) { return Math.max(1, Number(v) || 15) * 60000 }, '分钟'),
      numField('burstMs', '连发合并：同一个人连发几句算一轮', function (ms) { return Math.round(Number(ms) / 100) / 10 }, function (v) { return Math.max(1, Number(v) || 2.5) * 1000 }, '秒'),
      h('label', { style: S.row },
        h('span', { style: S.rowText },
          h('div', { style: S.rowTitle }, '叫她名字就算找她'),
          h('div', { style: S.rowHelp }, '逗号分隔，按这些词匹配群里的话'),
        ),
        h('input', {
          type: 'text',
          style: S.wide,
          disabled: saving,
          value: (gate.nameHints || []).join('，'),
          onChange: function (e) { setGate('nameHints')(e.target.value.split(/[，,、\s]+/).filter(Boolean)) },
        }),
      ),

      h('div', { style: S.group }, '个性提示词'),
      h('p', { style: S.hint }, '写在这里就等于写进她的人设：语气、称呼、口头禅、禁忌都按这个来。群聊和私聊分开写，留空就沿用配置文件里原来的 groupPrompt / directPrompt。'),
      h('p', { style: S.hint }, '以前用第三方桥（SnowLuma / NapCat 那套）的：把旧人设原文粘进来，或者直接跟 DSH 说「把旧桥的人设和记忆迁移到 QQ 机器人」，它会读旧配置写进这里。'),
      personaField('group', '群里的人格设定', '群里说话的风格（对应 groupPrompt）', '例：你是群里的鲸鱼娘小肥鱼，短句、爱撒娇，不用括号旁白，不客服腔…'),
      personaField('direct', '私聊的人格设定', '私聊时的风格（对应 directPrompt）', '例：私聊更放松，叫对方爸爸，语气黏一点，可以多说两句…'),

      h('div', { style: S.bar },
        h('button', { type: 'button', style: S.btnPrimary, disabled: saving || !dirty, onClick: save }, '保存'),
        h('button', { type: 'button', style: S.btn, disabled: saving || !dirty, onClick: function () { setDraft({ features: {}, gate: {}, persona: {} }); setStatus('已撤销改动') } }, '撤销'),
        h('button', { type: 'button', style: S.btn, onClick: loadLog }, '看诊断日志'),
        h('span', { style: S.status }, status),
      ),

      logLines ? h('pre', { style: S.pre }, logLines.join('\n') || '(暂无日志)') : null,
      h('p', { style: S.code }, '配置文件：' + data.file),
    )
  }

  module.exports.name = 'qq-bot-pro-client'
  module.exports.inject = ['slots']
  module.exports.apply = function apply(ctx) {
    try {
      ctx.slots.inject('settings.plugins.tab', function () {
        return ctx.slots.register(
          { name: 'settings.plugins.tab', id: 'qq-bot-pro', order: 60, label: 'QQ 机器人' },
          SettingsPage,
        )
      })
    } catch (e) {
      try { console.warn('[qq-bot-pro] settings tab disabled:', e) } catch { }
    }
  }
  return module.exports
} })

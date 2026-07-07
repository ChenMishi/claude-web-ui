import { useApp } from '../context/AppContext';

export default function WelcomeScreen() {
  const { currentModel, systemPrompt, setSetting, availableModels, modelGroups, switchCurrentModel, currentProjectId } = useApp();

  return (
    <div className="welcome">
      <h2>你好！开始对话</h2>
      <p>
        {currentProjectId
          ? '在下方输入框输入消息开始和 Claude 对话。'
          : '请先在侧边栏选择一个项目。'}
      </p>
      <div className="welcome-config">
        <label>Model</label>
        <select value={currentModel} onChange={e => switchCurrentModel(e.target.value)}>
          {Object.keys(modelGroups).length > 0 ? (
            Object.entries(modelGroups).map(([id, g]) => (
              <optgroup key={id} label={`----${g.name}----`}>
                {g.models.map(m => <option key={m} value={m}>{m}</option>)}
              </optgroup>
            ))
          ) : availableModels.length > 0 ? (
            availableModels.map(m => <option key={m} value={m}>{m}</option>)
          ) : (
            <>
              <option value="claude-opus-4-7">Claude Opus 4.7</option>
              <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
              <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
            </>
          )}
        </select>

        <label>System Prompt (可选)</label>
        <input
          type="text"
          value={systemPrompt}
          onChange={e => setSetting('systemPrompt', e.target.value)}
          placeholder="自定义 system prompt..."
        />
      </div>
    </div>
  );
}

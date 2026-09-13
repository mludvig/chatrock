import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faGlobe, faMemory, faMagnifyingGlass, faClock, faImage } from '@fortawesome/free-solid-svg-icons'
import type { ModelSettings } from '../api/http'

interface Props {
  settings: ModelSettings
  onChange: (s: ModelSettings) => void
  // ChatDetailsDialog renders its own Memory row in the Privacy section instead —
  // see docs/adr/0014-memory-toggle-lives-in-privacy-section.md.
  hideMemory?: boolean
}

// Every capability the model can reach for during a turn — none of these are
// gated by model capabilities (unlike ModelTuningPanel), so no `caps` prop is needed.
export default function ToolsPanel({ settings, onChange, hideMemory }: Props) {
  function set(patch: Partial<ModelSettings>) {
    onChange({ ...settings, ...patch })
  }

  return (
    <details className="model-settings advanced-tools">
      <summary className="pref-label">Advanced tools</summary>

      <div className="model-setting-row model-setting-row--inline">
        <label className="setting-label" title="Toggle web search (Jina). When off, the model cannot call web_search or web_fetch tools.">
          <FontAwesomeIcon icon={faGlobe} />
          <span>Web search</span>
        </label>
        <button
          className={`toggle-btn${settings.webSearchEnabled !== false ? ' active' : ''}`}
          onClick={() => set({ webSearchEnabled: settings.webSearchEnabled === false ? true : false })}
          title="Toggle web search"
        >
          {settings.webSearchEnabled !== false ? 'On' : 'Off'}
        </button>
      </div>
      <div className="model-setting-row model-setting-row--inline">
        <label className="setting-label" title="Toggle take_screenshot / get_rendered_page. When off, the model cannot screenshot a page or read its JS-rendered content.">
          <FontAwesomeIcon icon={faGlobe} />
          <span>Browse websites</span>
        </label>
        <button
          className={`toggle-btn${settings.browserCoreEnabled !== false ? ' active' : ''}`}
          onClick={() => set({ browserCoreEnabled: settings.browserCoreEnabled === false ? true : false })}
          title="Toggle browser core tools"
        >
          {settings.browserCoreEnabled !== false ? 'On' : 'Off'}
        </button>
      </div>
      <div className="model-setting-row model-setting-row--inline">
        <label className="setting-label" title="Toggle browse_web. When on, the model can run multi-step scripted browsing (click, type, navigate between pages) in one isolated browser session.">
          <FontAwesomeIcon icon={faGlobe} />
          <span>Interact with websites</span>
        </label>
        <button
          className={`toggle-btn${settings.browserExtendedEnabled === true ? ' active' : ''}`}
          onClick={() => set({ browserExtendedEnabled: settings.browserExtendedEnabled === true ? false : true })}
          title="Toggle scripted browsing"
        >
          {settings.browserExtendedEnabled === true ? 'On' : 'Off'}
        </button>
      </div>
      {!hideMemory && (
        <div className="model-setting-row model-setting-row--inline">
          <label className="setting-label" title="Toggle memory. When off, your saved memories are not injected into the system prompt and no new memories are extracted from this chat.">
            <FontAwesomeIcon icon={faMemory} />
            <span>Memory</span>
          </label>
          <button
            className={`toggle-btn${settings.memoryEnabled !== false ? ' active' : ''}`}
            onClick={() => set({ memoryEnabled: settings.memoryEnabled === false ? true : false })}
            title="Toggle memory"
          >
            {settings.memoryEnabled !== false ? 'On' : 'Off'}
          </button>
        </div>
      )}
      <div className="model-setting-row model-setting-row--inline">
        <label className="setting-label" title="Toggle the search_history tool. When off, the model cannot organically search your past chats and project files mid-conversation — the explicit Search box (header) still works regardless.">
          <FontAwesomeIcon icon={faMagnifyingGlass} />
          <span>Search history</span>
        </label>
        <button
          className={`toggle-btn${settings.searchEnabled !== false ? ' active' : ''}`}
          onClick={() => set({ searchEnabled: settings.searchEnabled === false ? true : false })}
          title="Toggle search history"
        >
          {settings.searchEnabled !== false ? 'On' : 'Off'}
        </button>
      </div>
      <div className="model-setting-row model-setting-row--inline">
        <label className="setting-label" title="Toggle the generate_image tool (Stability AI via Bedrock). Off by default — each call costs money. When on, the model can generate images from a text description mid-conversation.">
          <FontAwesomeIcon icon={faImage} />
          <span>Image generation</span>
        </label>
        <button
          className={`toggle-btn${settings.imageGenerationEnabled === true ? ' active' : ''}`}
          onClick={() => set({ imageGenerationEnabled: settings.imageGenerationEnabled === true ? false : true })}
          title="Toggle image generation"
        >
          {settings.imageGenerationEnabled === true ? 'On' : 'Off'}
        </button>
      </div>
      <div className="model-setting-row model-setting-row--inline">
        <label className="setting-label" title="Inject the current date/time into the system prompt, so the model knows 'now' without you having to say it.">
          <FontAwesomeIcon icon={faClock} />
          <span>Include current date and time</span>
        </label>
        <button
          className={`toggle-btn${settings.injectCurrentDate !== false ? ' active' : ''}`}
          onClick={() => set({ injectCurrentDate: settings.injectCurrentDate === false ? true : false })}
          title="Toggle timestamp injection"
        >
          {settings.injectCurrentDate !== false ? 'On' : 'Off'}
        </button>
      </div>
    </details>
  )
}

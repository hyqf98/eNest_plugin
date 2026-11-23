import { Icon } from '../components/Icon.jsx'

export function PinsView({ pins, loading, onRefresh, onClosePin, onCloseAll, onPinCapture, onPinClipboard, onPinFile }) {
  return (
    <div className="sa-view">
      <div className="sa-pins">
        <div className="sa-pin-actions">
          <button type="button" className="sa-pin-action" onClick={onPinCapture}>
            <Icon name="capture" />
            <strong>截图并贴</strong>
          </button>
          <button type="button" className="sa-pin-action" onClick={onPinClipboard}>
            <Icon name="clipboard" />
            <strong>贴剪贴板</strong>
          </button>
          <button type="button" className="sa-pin-action" onClick={onPinFile}>
            <Icon name="image" />
            <strong>贴本地图片</strong>
          </button>
        </div>

        <div className="sa-pin-list">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28 }}>
            <span className="sa-muted" style={{ fontSize: 11 }}>{loading ? '正在读取…' : `${pins?.length || 0} 张贴图`}</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="sa-icon-btn text" onClick={onRefresh} disabled={loading}>
              <Icon name="refresh" size={13} /> 刷新
            </button>
            <button type="button" className="sa-icon-btn text" onClick={onCloseAll} disabled={!pins?.length}>
              全部关闭
            </button>
          </div>
          {loading ? (
            <div className="sa-empty"><span className="sa-spinner" /> 正在读取贴图…</div>
          ) : pins?.length ? pins.map((pin, index) => (
            <div key={pin.pinId} className="sa-pin-row">
              <span>贴图 {index + 1}</span>
              <small className="sa-mono">{String(pin.pinId).slice(0, 8)}</small>
              <button type="button" className="sa-icon-btn" aria-label={`关闭贴图 ${index + 1}`} title="关闭" onClick={() => onClosePin(pin.pinId)}>
                <Icon name="close" size={14} />
              </button>
            </div>
          )) : (
            <div className="sa-empty"><Icon name="pin" />还没有贴图</div>
          )}
        </div>
      </div>
    </div>
  )
}

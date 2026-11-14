import { useEffect, useState } from 'react';
import { api } from '../api';
import type { VersionCriterion, VersionSettings } from '../types';

const ALL_CRITERIA: VersionCriterion[] = ['resolution', 'hdr', 'size'];
const CRITERIA_LABELS: Record<VersionCriterion, string> = {
  resolution: '分辨率',
  hdr: '画质（HDR / 杜比视界）',
  size: '文件大小',
};

/**
 * 选版设置卡：模式（只存最优 / 先存后优）+ 评分依据排序 + 文件大小方向。
 * 自行拉取 /api/settings 回填，不参与 App 的 15 秒轮询，避免冲掉正在编辑的内容；
 * 保存走 PUT /api/settings，worker 每轮轮询时读取最新值生效。
 */
export default function VersionSettingsPanel({ flash }: {
  flash: (msg: string, ok: boolean) => void;
}) {
  const [mode, setMode] = useState<VersionSettings['version_mode']>('best');
  const [criteria, setCriteria] = useState<VersionCriterion[]>(['resolution', 'hdr', 'size']);
  const [sizePrefer, setSizePrefer] = useState<VersionSettings['version_size_prefer']>('bigger');
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.settings()
      .then((s) => {
        setMode(s.version_mode);
        setCriteria(s.version_criteria);
        setSizePrefer(s.version_size_prefer);
      })
      .catch(() => { /* 读不到就保留内置默认，保存时再报错 */ })
      .finally(() => setLoaded(true));
  }, []);

  const touch = () => setDirty(true);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= criteria.length) return;
    const next = [...criteria];
    [next[i], next[j]] = [next[j], next[i]];
    setCriteria(next); touch();
  };
  const remove = (c: VersionCriterion) => { setCriteria(criteria.filter((x) => x !== c)); touch(); };
  const add = (c: VersionCriterion) => { setCriteria([...criteria, c]); touch(); };
  const inactive = ALL_CRITERIA.filter((c) => !criteria.includes(c));

  const save = async () => {
    if (!criteria.length) { flash('评分依据至少保留一项', false); return; }
    setSaving(true);
    try {
      const s = await api.saveSettings({
        version_mode: mode, version_criteria: criteria, version_size_prefer: sizePrefer,
      });
      setMode(s.version_mode); setCriteria(s.version_criteria); setSizePrefer(s.version_size_prefer);
      setDirty(false);
      flash('选版设置已保存，worker 下一轮轮询即按新设置选版', true);
    } catch (e) {
      flash(e instanceof Error ? e.message : '保存失败', false);
    } finally { setSaving(false); }
  };

  return (
    <section className="panel">
      <h2>选版设置</h2>
      <p className="hint">
        同一集只存一个版本，存哪个由这里决定（纯个人口味）。worker 每轮轮询时读取本设置；
        从未保存过时按环境变量 VERSION_POLICY 的映射值生效。
      </p>

      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', marginBottom: 6, cursor: 'pointer' }}>
          <input type="radio" name="version-mode" checked={mode === 'best'}
            onChange={() => { setMode('best'); touch(); }} />{' '}
          <b>只存最优版（best）</b>——只存按下面排序最优的一个版本；这一集候选都不理想时就不存，等更好的出现。
        </label>
        <label style={{ display: 'block', cursor: 'pointer' }}>
          <input type="radio" name="version-mode" checked={mode === 'any_upgrade'}
            onChange={() => { setMode('any_upgrade'); touch(); }} />{' '}
          <b>先到先存、更优替换（any_upgrade）</b>——先存先到的版本，新集优先入库不等待；之后发现更优版本再自动替换旧版。
        </label>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div className="meta" style={{ marginBottom: 6 }}>
          评分依据（从上到下依次比较，先分出胜负的维度说了算）：
        </div>
        {criteria.map((c, i) => (
          <div key={c} className="form-grid" style={{ marginBottom: 6 }}>
            <span style={{ minWidth: 170 }}>{i + 1}. {CRITERIA_LABELS[c]}</span>
            <button onClick={() => move(i, -1)} disabled={i === 0}>上移</button>
            <button onClick={() => move(i, 1)} disabled={i === criteria.length - 1}>下移</button>
            <button onClick={() => remove(c)} disabled={criteria.length <= 1}>移出</button>
          </div>
        ))}
        {inactive.length > 0 && (
          <div className="form-grid">
            <span className="meta">未启用：</span>
            {inactive.map((c) => (
              <button key={c} onClick={() => add(c)}>加入 {CRITERIA_LABELS[c]}</button>
            ))}
          </div>
        )}
      </div>

      <div className="form-grid">
        <span className="meta">文件大小偏好（只影响「文件大小」这一维度）：</span>
        <label style={{ cursor: 'pointer' }}>
          <input type="radio" name="size-prefer" checked={sizePrefer === 'bigger'}
            onChange={() => { setSizePrefer('bigger'); touch(); }} /> 越大越好
        </label>
        <label style={{ cursor: 'pointer' }}>
          <input type="radio" name="size-prefer" checked={sizePrefer === 'smaller'}
            onChange={() => { setSizePrefer('smaller'); touch(); }} /> 越小越好（省空间）
        </label>
      </div>

      <div className="form-grid" style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => void save()} disabled={!loaded || saving}>
          {saving ? '保存中…' : '保存选版设置'}
        </button>
        {dirty && <span className="meta">有未保存的修改</span>}
      </div>
    </section>
  );
}

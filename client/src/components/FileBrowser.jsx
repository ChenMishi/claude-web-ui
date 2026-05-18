import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { getProjectTree, readFile } from '../api';
import FileViewer from './FileViewer';

export default function FileBrowser() {
  const { currentProjectId } = useApp();
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [fileSize, setFileSize] = useState(0);

  useEffect(() => {
    if (currentProjectId) {
      setLoading(true);
      setError(null);
      getProjectTree(currentProjectId)
        .then(data => { setTree(data); setLoading(false); })
        .catch(err => { setError(err.message); setLoading(false); });
    }
  }, [currentProjectId]);

  const handleFileClick = async (item) => {
    if (item.type === 'dir') return;
    try {
      const data = await readFile(currentProjectId, item.path);
      setFileContent(data.content);
      setFileSize(data.size);
      setSelectedFile(item);
    } catch (err) {
      setFileContent(`// Error: ${err.message}`);
      setSelectedFile(item);
    }
  };

  if (!currentProjectId) {
    return <div className="empty-state">请先在侧边栏选择一个项目</div>;
  }

  return (
    <div className="file-browser">
      <div className="file-tree-panel">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--accent)' }}>
          📁 文件浏览
        </div>
        {tree.map(item => (
          <FileTreeNode key={item.path} item={item} onFileClick={handleFileClick} depth={0} />
        ))}
        {error && (
          <div style={{ textAlign: 'center', color: 'var(--danger)', fontSize: 12, padding: 20 }}>
            加载失败: {error}
          </div>
        )}
        {!error && loading && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 20 }}>
            加载中...
          </div>
        )}
        {!error && !loading && tree.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: 20 }}>
            目录为空
          </div>
        )}
      </div>
      {selectedFile ? (
        <FileViewer file={selectedFile} content={fileContent} size={fileSize} />
      ) : (
        <div className="empty-state">选择左侧文件以查看内容</div>
      )}
    </div>
  );
}

function FileTreeNode({ item, onFileClick, depth }) {
  const [expanded, setExpanded] = useState(depth < 1);

  if (item.type === 'dir') {
    return (
      <div>
        <div
          className="file-tree-item dir"
          onClick={() => setExpanded(!expanded)}
          style={{ paddingLeft: 8 + depth * 16 }}
        >
          {expanded ? '📂' : '📁'} {item.name}
        </div>
        {expanded && item.children && (
          <div className="file-tree-children">
            {item.children.map(child => (
              <FileTreeNode key={child.path} item={child} onFileClick={onFileClick} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const ext = item.name?.split('.').pop();
  const icons = { js: '📜', jsx: '📜', ts: '📘', tsx: '📘', css: '🎨', html: '🌐', json: '📋', md: '📝', py: '🐍', go: '🔵' };
  const icon = icons[ext] || '📄';

  return (
    <div
      className="file-tree-item"
      onClick={() => onFileClick(item)}
      style={{ paddingLeft: 8 + depth * 16 }}
    >
      {icon} {item.name}
    </div>
  );
}

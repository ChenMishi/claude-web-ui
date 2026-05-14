import { useApp } from '../context/AppContext';

export default function FileViewer({ file, content, size }) {
  const { currentProjectId } = useApp();

  const formatSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const ext = file?.name?.split('.').pop();
  const langClass = ['js', 'jsx', 'ts', 'tsx', 'css', 'html', 'json', 'py', 'go', 'sh', 'yaml', 'yml', 'sql'].includes(ext) ? ext : '';

  return (
    <div className="file-viewer">
      <div className="file-viewer-header">
        <div>
          <h3>{file?.path}</h3>
        </div>
        <span>{formatSize(size)}</span>
      </div>
      <div className="file-viewer-content">
        {content || '// 空文件'}
      </div>
    </div>
  );
}

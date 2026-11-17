import { useEffect, useRef } from 'react';

/** Thumbnail via an object URL that is revoked when the file changes or unmounts. */
function Thumb({ file, alt }: { file: File; alt: string }) {
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    if (img.current) img.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <img ref={img} alt={alt} />;
}

type Props = {
  files: File[];
  onChange: (files: File[]) => void;
  max: number;
  /** Which camera to prefer when the "Use camera" button is used on mobile. */
  camera: 'user' | 'environment';
  disabled?: boolean;
};

/** Pick up to `max` photos from disk/gallery or the device camera, with thumbnails. */
export function PhotoPicker({ files, onChange, max, camera, disabled }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  const add = (list: FileList | null) => {
    if (!list) return;
    const images = Array.from(list).filter((f) => f.type.startsWith('image/') || f.type === '');
    const next = max === 1 ? images.slice(0, 1) : [...files, ...images].slice(0, max);
    onChange(next);
  };

  const full = max > 1 && files.length >= max;

  return (
    <div className="picker">
      <div className="picker-actions">
        <button
          type="button"
          className="btn"
          disabled={disabled || full}
          onClick={() => fileInput.current?.click()}
        >
          {max === 1 ? (files.length ? 'Choose another photo' : 'Choose photo') : 'Add photos'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={disabled || full}
          onClick={() => cameraInput.current?.click()}
        >
          Use camera
        </button>
        {max > 1 && (
          <span className="muted small">
            {files.length} of {max} selected
          </span>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple={max > 1}
        hidden
        onChange={(e) => {
          add(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture={camera}
        hidden
        onChange={(e) => {
          add(e.target.files);
          e.target.value = '';
        }}
      />
      {files.length > 0 && (
        <ul className="thumbs">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.lastModified}-${i}`} className="thumb">
              <Thumb file={f} alt={f.name || `Photo ${i + 1}`} />
              {!disabled && (
                <button
                  type="button"
                  className="thumb-remove"
                  aria-label={`Remove ${f.name || `photo ${i + 1}`}`}
                  onClick={() => onChange(files.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

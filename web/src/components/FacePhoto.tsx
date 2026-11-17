import { useState } from 'react';
import type { SessionPhoto } from '../api';

type Props = {
  photo: SessionPhoto;
  index: number;
  /** studentId → display name, for labelling matched faces. */
  names: Map<string, string>;
  onExpired?: () => void;
};

/** A session photo with Rekognition face boxes (ratios of the image) drawn on top. */
export function FacePhoto({ photo, index, names, onExpired }: Props) {
  const [failed, setFailed] = useState(false);
  const matched = photo.faces.filter((f) => f.studentId).length;

  return (
    <figure className="face-photo">
      {photo.note && (
        <p className="photo-note" role="note">
          <span aria-hidden="true">!</span>
          <span>{photo.note}</span>
        </p>
      )}
      {failed ? (
        <div className="face-photo-missing">
          <p>The photo link has expired or the image could not load.</p>
          {onExpired && (
            <button type="button" className="btn btn-sm" onClick={onExpired}>
              Reload session
            </button>
          )}
        </div>
      ) : (
        <div className="face-stage">
          <img src={photo.url} alt={`Classroom photo ${index + 1}`} onError={() => setFailed(true)} />
          {photo.faces.map((face, i) => {
            const { left, top, width, height } = face.box;
            const known = !!face.studentId;
            const name = known ? names.get(face.studentId!) ?? face.studentId! : 'unknown';
            const sim = face.similarity != null ? ` · ${face.similarity.toFixed(1)}% match` : '';
            return (
              <div
                key={i}
                className={known ? 'face-box face-known' : 'face-box face-unknown'}
                style={{
                  left: `${left * 100}%`,
                  top: `${top * 100}%`,
                  width: `${width * 100}%`,
                  height: `${height * 100}%`,
                }}
                title={`${name}${sim}`}
              >
                <span className={top < 0.07 ? 'face-label face-label-below' : 'face-label'}>{name}</span>
              </div>
            );
          })}
        </div>
      )}
      <figcaption className="muted small">
        {photo.note && photo.faces.length === 0
          ? `Photo ${index + 1}: not analysed`
          : `Photo ${index + 1}: ${photo.faces.length} face${photo.faces.length === 1 ? '' : 's'} detected, ${matched} recognised`}
      </figcaption>
    </figure>
  );
}

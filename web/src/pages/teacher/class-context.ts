import { useOutletContext } from 'react-router-dom';
import type { Class } from '../../api';

export type ClassContext = {
  cls: Class;
  setCls: (cls: Class) => void;
  /** Re-read the class (e.g. after a new session changed sessionCount). */
  reload: () => void;
};

export function useClass(): ClassContext {
  return useOutletContext<ClassContext>();
}

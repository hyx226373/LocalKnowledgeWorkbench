/**
 * 总览、快速切换或启动设置打开时走可选端口。端口缺省则不调用。
 */
import { useEffect, useRef } from 'react';
import { closeOverlayHost, openOverlayHost, overlayHostStatus, type OverlayHostPort } from './overlayHost';

export function OverlayHostSync({
  active,
  workspaceId,
  port,
}: {
  active: boolean;
  workspaceId: string;
  port?: OverlayHostPort | null;
}) {
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const portRef = useRef(port);
  portRef.current = port;
  useEffect(() => {
    if (!active) return;
    const session = openOverlayHost(portRef.current, workspaceRef.current);
    return () => {
      closeOverlayHost(portRef.current, session, workspaceRef.current);
    };
  }, [active]);
  return <span className="kb-ws-quick-host-gate" data-host-status={overlayHostStatus(port)} hidden />;
}
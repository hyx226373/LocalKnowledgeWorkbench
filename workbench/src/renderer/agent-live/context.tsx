import React, { useEffect, useMemo } from 'react';
import './agent-live.css';
import { bindAgentLive, type LiveBinding } from './actions';
import type { AgentLiveClient } from './client';
import type { AgentLiveHost } from './host';

const Ctx = React.createContext<LiveBinding | null>(null);

export function AgentLiveProvider({ client, host, children }: { client: AgentLiveClient; host: AgentLiveHost; children: React.ReactNode }) {
  const binding = useMemo(() => ({ client, host }), [client, host]);
  useEffect(() => {
    bindAgentLive(binding);
    return () => {
      if (bindAgentLive) bindAgentLive(null);
    };
  }, [binding]);
  return <Ctx.Provider value={binding}>{children}</Ctx.Provider>;
}

export function useAgentLive(): LiveBinding | null {
  return React.useContext(Ctx);
}

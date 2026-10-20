import { FolderTree, Bookmark, Globe, Files, Bot, Puzzle } from 'lucide-react';
import type { DrawerModuleId } from './order';
const icons = { root: FolderTree, fav: Bookmark, web: Globe, bench: Files, agent: Bot, plugin: Puzzle };
export function ModuleIcon({ id }: { id: DrawerModuleId }) { const Icon = icons[id]; return <Icon size={16} aria-hidden="true"/>; }

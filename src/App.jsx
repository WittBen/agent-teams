import EntityIcon from './EntityIcon';
import Icon from './Icon';
import React, { useState } from 'react';
import { useStore } from './store';
import ChatView from './ChatView';
import CrossGroupCoordinator from './CrossGroupCoordinator';
import { AgentModal, GroupModal, SettingsPanel } from './Modals';
import { useI18n } from './i18n';
import { getProviderEmoji } from './provider-catalog';

function formatTime(ts, language) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const locale = language === 'en' ? 'en-US' : 'de-DE';
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
}

function Avatar({ agent, size = 46 }) {
  if (!agent) return <div className="avatar color-0" style={{ width: size, height: size, fontSize: size * 0.42 }}>?</div>;
  return (
    <div className={`avatar color-${agent.color ?? 0}`} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      <EntityIcon value={agent.emoji} size={size * 0.52} />
    </div>
  );
}

export default function App() {
  const { language, t } = useI18n();
  const { agents, groups, messages, providerConnections, addAgent, updateAgent, deleteAgent, addGroup, updateGroup, deleteGroup, updateTaskGraph } = useStore();
  const [activeChatId, setActiveChatId] = useState(null);
  const [search, setSearch] = useState('');
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupModalTab, setGroupModalTab] = useState('general');
  const [editAgent, setEditAgent] = useState(null);
  const [expertDraft, setExpertDraft] = useState(null);
  const [editGroup, setEditGroup] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarTab, setSidebarTab] = useState('chats'); // 'chats' | 'agents'

  // Build chat list from groups + agents
  const allChats = [
    ...groups.map(g => ({ ...g, type: 'group' })),
    ...agents.map(a => ({ ...a, type: 'direct' })),
  ];
  const activeChat = allChats.find(chat => chat.id === activeChatId) || null;

  const filtered = allChats.filter(c =>
    String(c.name || '').toLowerCase().includes(search.toLowerCase())
  );

  const getLastMessage = (chatId) => {
    const msgs = messages[chatId] || [];
    return msgs[msgs.length - 1] || null;
  };

  const getPreview = (msg) => {
    if (!msg) return t('Noch keine Nachrichten');
    const text = msg.text || '';
    if (msg.agentId === 'user') return t('Du: {text}', { text });
    if (msg.agentId === 'system') return text.split('|').pop() || '';
    return `${msg.senderName || ''}: ${text}`;
  };

  return (
    <div className="app-shell">
      {/* Custom Titlebar */}
      <div className="titlebar">
        <div className="titlebar-left">
          <span className="titlebar-logo"><Icon name="chat" /></span>
          <span className="titlebar-title">Agent Teams</span>
        </div>
        <div className="titlebar-controls">
          <button className="titlebar-btn" aria-label={t('Fenster minimieren')} onClick={() => window.electronAPI?.minimize()}><Icon name="minus" /></button>
          <button className="titlebar-btn" aria-label={t('Fenster maximieren')} onClick={() => window.electronAPI?.maximize()}><Icon name="maximize" /></button>
          <button className="titlebar-btn close" aria-label={t('Fenster schließen')} onClick={() => window.electronAPI?.close()}><Icon name="close" /></button>
        </div>
      </div>

      <div className="app-layout">
        <CrossGroupCoordinator />
        {/* Sidebar */}
        <div className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
          {/* Sidebar Header */}
          <div className="sidebar-header">
            {sidebarCollapsed ? (
              <button className="icon-btn" title={t('Agenten- und Chatliste ausklappen')} aria-label={t('Agenten- und Chatliste ausklappen')} onClick={() => setSidebarCollapsed(false)}><Icon name="panelRight" /></button>
            ) : (
              <>
                <div className="sidebar-header-title">
                  {sidebarTab === 'chats' ? t('Chats') : t('Agenten')}
                </div>
                <div className="sidebar-header-actions">
                  <button className={`icon-btn ${sidebarTab === 'chats' ? 'active' : ''}`} title={t('Chats')} onClick={() => { setSidebarTab('chats'); setShowSettings(false); }}><Icon name="chat" /></button>
                  <button className={`icon-btn ${sidebarTab === 'agents' ? 'active' : ''}`} title={t('Agenten verwalten')} onClick={() => { setSidebarTab('agents'); setShowSettings(false); }}><Icon name="agents" /></button>
                  <button className="icon-btn" title={t('Einstellungen')} onClick={() => setShowSettings(true)}><Icon name="settings" /></button>
                  <button className="icon-btn" title={t('Agenten- und Chatliste einklappen')} aria-label={t('Agenten- und Chatliste einklappen')} onClick={() => setSidebarCollapsed(true)}><Icon name="panelLeft" /></button>
                </div>
              </>
            )}
          </div>

          {!sidebarCollapsed && sidebarTab === 'chats' && (
            <>
              {/* Search */}
              <div className="search-bar">
                <div className="search-wrapper">
                  <span className="search-icon"><Icon name="search" /></span>
                  <input
                    className="search-input"
                    placeholder={t('Suchen oder neuen Chat starten')}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                </div>
              </div>

              {/* Action buttons */}
              <div className="sidebar-create-row">
                <button className="btn btn-primary" style={{ flex: 1, fontSize: 12, padding: '7px 10px' }}
                  onClick={() => { setEditGroup(null); setShowGroupModal(true); }}>
                  <Icon name="plus" size={16} /> {t('Gruppe')}
                </button>
              </div>

              {/* Chat list */}
              <div className="chat-list">
                {filtered.length === 0 && (
                  <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    {t('Keine Chats gefunden')}
                  </div>
                )}
                {/* Groups section */}
                {filtered.filter(c => c.type === 'group').length > 0 && (
                  <>
                    <div className="section-label">{t('Gruppen')}</div>
                    {filtered.filter(c => c.type === 'group').map(chat => {
                      const last = getLastMessage(chat.id);
                      return (
                        <div
                          key={chat.id}
                          className={`chat-item ${activeChat?.id === chat.id ? 'active' : ''}`}
                          onClick={() => setActiveChatId(chat.id)}
                          onKeyDown={event => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setActiveChatId(chat.id);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          aria-label={t('Chat öffnen: {name}', { name: chat.name })}
                          style={{ position: 'relative' }}
                        >
                          <div className="avatar group" style={{ fontSize: 22 }}><EntityIcon value={chat.emoji} group size={24} /></div>
                          <div className="chat-item-info">
                            <div className="chat-item-top">
                              <span className="chat-item-name">{chat.name}</span>
                              <span className="chat-item-time">{formatTime(last?.ts, language)}</span>
                            </div>
                            <div className="chat-item-preview">{getPreview(last)}</div>
                          </div>
                          <div className="chat-item-actions">
                            <button className="icon-btn" style={{ fontSize: 12, width: 28, height: 28 }} title={t('Bearbeiten')}
                              onClick={(e) => { e.stopPropagation(); setEditGroup(chat); setShowGroupModal(true); }}><Icon name="edit" /></button>
                            <button className="icon-btn" style={{ fontSize: 12, width: 28, height: 28 }} title={t('Löschen')}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!confirm(t('Gruppe „{name}“ und alle lokalen Chatdaten wirklich löschen?', { name: chat.name }))) return;
                                deleteGroup(chat.id);
                                if (activeChatId === chat.id) setActiveChatId(null);
                              }}><Icon name="trash" /></button>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
                {/* Direct agent chats */}
                {filtered.filter(c => c.type === 'direct').length > 0 && (
                  <>
                    <div className="section-label">{t('Direkt')}</div>
                    {filtered.filter(c => c.type === 'direct').map(chat => {
                      const last = getLastMessage(chat.id);
                      return (
                        <div
                          key={chat.id}
                          className={`chat-item ${activeChat?.id === chat.id ? 'active' : ''}`}
                          onClick={() => setActiveChatId(chat.id)}
                          onKeyDown={event => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setActiveChatId(chat.id);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          aria-label={t('Chat öffnen: {name}', { name: chat.name })}
                        >
                          <Avatar agent={chat} size={46} />
                          <div className="chat-item-info">
                            <div className="chat-item-top">
                              <span className="chat-item-name">{chat.name}</span>
                              <span className="chat-item-time">{formatTime(last?.ts, language)}</span>
                            </div>
                            <div className="chat-item-preview">{chat.role || 'Agent'}</div>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            </>
          )}

          {!sidebarCollapsed && sidebarTab === 'agents' && (
            <>
              <div className="sidebar-create-row">
                <button className="btn btn-primary" style={{ width: '100%', fontSize: 13 }}
                  onClick={() => { setEditAgent(null); setShowAgentModal(true); }}>
                  <Icon name="plus" size={16} /> {t('Neuen Agenten erstellen')}
                </button>
              </div>
              <div className="agent-list">
                {agents.length === 0 && (
                  <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    {t('Noch keine Agenten. Erstelle deinen ersten!')}
                  </div>
                )}
                {agents.map(agent => (
                  <div key={agent.id} className="agent-card">
                    <Avatar agent={agent} size={40} />
                    <div className="agent-card-info">
                      <div className="agent-card-name"><EntityIcon value={agent.emoji} size={16} /> {agent.name}</div>
                      <div className="agent-card-role">
                        {getProviderEmoji(agent.provider, providerConnections)} {agent.role || 'Agent'} · {agent.model || ''}
                      </div>
                    </div>
                    <div className="agent-card-actions">
                      <button className="icon-btn" style={{ fontSize: 13 }} title={t('Bearbeiten')}
                        onClick={() => { setEditAgent(agent); setShowAgentModal(true); }}><Icon name="edit" /></button>
                      {!agent.isSystemAgent && (
                        <button className="icon-btn" style={{ fontSize: 13 }} title={t('Löschen')}
                          onClick={() => { if (confirm(t('Agent „{name}“ wirklich löschen?', { name: agent.name }))) deleteAgent(agent.id); }}><Icon name="trash" /></button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Main Chat Area */}
        <div className="chat-area">
          <div className="chat-bg" />
          {groups.map(group => (
            <div key={group.id} className={`chat-view-slot ${activeChat?.id === group.id ? 'active' : 'inactive'}`}>
              <ChatView
                chat={group}
                active={activeChat?.id === group.id}
                onCreateExpert={(sourceGroup, draft) => {
                  setEditAgent(null);
                  setExpertDraft({ sourceGroupId: sourceGroup.id, homeGroups: groups.filter(item => item.id !== sourceGroup.id).map(item => ({ id: item.id, name: item.name })), ...draft });
                  setShowAgentModal(true);
                }}
                onEditGroup={(editedGroup, options = {}) => {
                  setGroupModalTab(options.tab || 'general');
                  setEditGroup(editedGroup);
                  setShowGroupModal(true);
                }}
              />
            </div>
          ))}
          {activeChat?.type === 'direct' && (
            <ChatView key={activeChat.id} chat={activeChat} active />
          )}
          {!activeChat && (
            <div className="empty-state">
              <div className="empty-state-icon"><Icon name="workflow" size={42} /></div>
              <h1 className="empty-state-heading">Agent Teams</h1>
              <div className="empty-state-text">{t('Wähle einen Chat aus oder erstelle eine neue Gruppe')}</div>
              <button className="btn btn-primary" style={{ marginTop: 8 }}
                onClick={() => { setEditGroup(null); setShowGroupModal(true); }}>
                <Icon name="plus" size={16} /> {t('Neue Gruppe erstellen')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {showAgentModal && (
        <AgentModal
          agent={editAgent}
          draft={expertDraft}
          onClose={() => { setShowAgentModal(false); setEditAgent(null); setExpertDraft(null); }}
          onSave={(data, placement) => {
            if (editAgent) updateAgent(editAgent.id, data);
            else {
              const id = addAgent(data, expertDraft ? { sourceGroupId: expertDraft.sourceGroupId, ...placement } : null);
              if (expertDraft?.taskId) updateTaskGraph(expertDraft.sourceGroupId, graph => graph && ({ ...graph,
                nodes: graph.nodes.map(node => node.id === expertDraft.taskId ? { ...node, expertiseSuggestedAgentId: id } : node),
              }));
            }
          }}
        />
      )}
      {showGroupModal && (
        <GroupModal
          initialTab={groupModalTab}
          group={editGroup}
          groups={groups}
          agents={agents}
          onClose={() => { setShowGroupModal(false); setEditGroup(null); setGroupModalTab('general'); }}
          onSave={data => {
            if (editGroup) updateGroup(editGroup.id, data);
            else addGroup(data);
          }}
        />
      )}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}

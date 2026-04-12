import React, { useState } from 'react';
import { UserPlus, Users } from 'lucide-react';

export default function Collaborators({ currentWs, workspaces, setWorkspaces, activeWsIndex }) {
  const [inviting, setInviting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');

  const inviteCollaborator = (e) => {
    e.preventDefault();
    if (!inviteEmail) return;
    setInviting(true);
    setTimeout(() => {
       const copy = [...workspaces];
       copy[activeWsIndex] = { 
         ...copy[activeWsIndex],
         collaborators: [...(copy[activeWsIndex].collaborators || []), inviteEmail],
         type: 'shared'
       };
       setWorkspaces(copy);
       setInviteEmail('');
       setInviting(false);
    }, 800);
  };

  if (currentWs.type !== 'shared') {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 bg-background">
        <Users size={64} className="text-slate-600 mb-6 opacity-30" />
        <h2 className="text-xl font-bold text-slate-300 mb-2">Personal Workspace</h2>
        <p className="text-slate-500 max-w-sm text-center">Collaborators are only available in shared workspaces. Create or switch to a Shared Workspace to invite team members.</p>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col bg-background p-8 overflow-y-auto custom-scrollbar">
       <div className="flex justify-between items-center mb-12 border-b border-border pb-6">
         <div>
            <h2 className="text-3xl font-black text-white mb-2 tracking-tighter">Team Collaborators</h2>
            <p className="text-slate-400 text-lg">Manage workspace access and sync analysis branches across your research unit.</p>
         </div>
       </div>

       <div className="max-w-5xl animate-in fade-in slide-in-from-bottom-6">
          <div className="card p-10 bg-slate-800/40 relative overflow-hidden border border-border/50 shadow-2xl">
             <div className="relative z-10 flex flex-col md:flex-row gap-12">
                <div className="flex-1">
                   <h3 className="text-2xl font-black text-white mb-6 flex items-center gap-3">
                     <Users size={24} className="text-primary" /> Active Members
                   </h3>
                   <div className="space-y-4">
                      {currentWs.collaborators && currentWs.collaborators.length > 0 ? currentWs.collaborators.map(email => (
                         <div key={email} className="flex items-center gap-4 p-4 rounded-xl bg-black/30 border border-slate-700/50 hover:bg-black/40 transition-colors">
                            <div className="w-12 h-12 rounded-[16px] bg-primary flex items-center justify-center text-lg text-white font-black uppercase shadow-lg shadow-primary/20">
                               {email[0]}
                            </div>
                            <div className="flex-1">
                               <div className="text-white text-[15px] font-bold tracking-tight">{email}</div>
                               <div className="text-[10px] text-slate-500 uppercase font-black tracking-widest mt-0.5">Researcher</div>
                            </div>
                            <div className="text-[9px] text-success font-black border border-success/30 px-3 py-1 rounded-full uppercase tracking-wider bg-success/5 shadow-[0_0_10px_rgba(34,197,94,0.1)]">Online</div>
                         </div>
                      )) : (
                        <div className="p-12 text-center text-slate-500 border-2 border-dashed border-slate-700/50 rounded-2xl bg-black/10">
                          <Users size={32} className="mx-auto mb-4 opacity-50 text-slate-600" />
                          <div className="font-bold text-slate-400">No external collaborators yet.</div>
                          <div className="text-sm mt-1">Invite a researcher to begin sharing this workspace!</div>
                        </div>
                      )}
                   </div>
                </div>
                
                <div className="w-full md:w-80">
                   <div className="card p-8 bg-black/40 border border-border/40 shadow-inner">
                      <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-6 flex items-center gap-2">
                        <UserPlus size={16} /> Invite Researcher
                      </h4>
                      <form onSubmit={inviteCollaborator} className="space-y-4">
                         <div className="relative">
                            <input 
                              type="email"
                              required
                              className="w-full bg-slate-900/80 border border-slate-700 rounded-lg py-3 pl-4 pr-10 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-primary transition-all shadow-inner"
                              placeholder="researcher@lab.edu"
                              value={inviteEmail}
                              onChange={e => setInviteEmail(e.target.value)}
                            />
                            <UserPlus size={18} className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-600" />
                         </div>
                         <button type="submit" disabled={inviting || !inviteEmail} className="btn btn-primary w-full py-3 text-[13px] uppercase tracking-wider font-bold flex items-center justify-center gap-2 shadow-lg shadow-primary/20 hover:scale-[1.02] transition-transform">
                            {inviting ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div> : 'Send Invite'}
                         </button>
                      </form>
                   </div>
                </div>
             </div>
             
             {/* Decorative Background Icon */}
             <div className="absolute -bottom-16 -right-16 text-primary opacity-[0.03] pointer-events-none transform rotate-12">
                <Users size={240} />
             </div>
          </div>
       </div>
    </div>
  );
}

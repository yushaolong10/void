/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useIsDark } from '../util/services.js';
// import { SidebarThreadSelector } from './SidebarThreadSelector.js';
// import { SidebarChat } from './SidebarChat.js';

import '../styles.css'
import { SidebarChat } from './SidebarChat.js';
import ErrorBoundary from './ErrorBoundary.js';
import React, { useState } from 'react';
import { AgentTimeline } from './AgentTimeline.js';

export const Sidebar = ({ className }: { className: string }) => {

	const isDark = useIsDark()
	const [tab, setTab] = useState<'chat' | 'timeline'>('chat')
	return <div
		className={`@@void-scope ${isDark ? 'dark' : ''}`}
		style={{ width: '100%', height: '100%' }}
	>
		<div
			// default background + text styles for sidebar
			className={`
				w-full h-full
				bg-void-bg-2
				text-void-fg-1
			`}
		>

			<div className={`w-full h-full flex flex-col min-h-0`}>
				<div className='flex shrink-0 border-b border-void-border-3 bg-void-bg-1 px-2 py-1'>
					<button className={`px-3 py-1 text-xs ${tab === 'chat' ? 'text-void-fg-1' : 'text-void-fg-3'}`} onClick={() => setTab('chat')}>Chat</button>
					<button className={`px-3 py-1 text-xs ${tab === 'timeline' ? 'text-void-fg-1' : 'text-void-fg-3'}`} onClick={() => setTab('timeline')}>Timeline</button>
				</div>
				<div className='min-h-0 flex-1'>
				<ErrorBoundary>
					{tab === 'chat' ? <SidebarChat /> : <AgentTimeline />}
				</ErrorBoundary>
				</div>

			</div>
		</div>
	</div>


}

/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useCallback, useMemo, useState } from 'react'
import { Check, Clipboard, GitCompare, GitMerge, Trash2 } from 'lucide-react'
import { AgentEvent } from '../../../../common/agent/runtime/AgentEvent.js'
import { AgentSessionState } from '../../../../common/agent/runtime/AgentState.js'
import { safeStringify } from '../../../../common/agent/tools/safeSerialize.js'
import { useAccessor, useAgentTimelineState } from '../util/services.js'

type CandidatePatch = {
	id: string;
	path: string;
	branchName: string;
	createdAt: number;
	review?: string;
}

const eventTitle = (event: AgentEvent) => {
	if (event.type === 'run.started') return 'Run started'
	if (event.type === 'model.delta') return 'Model'
	if (event.type === 'tool.requested') return `Requested ${event.call.name}`
	if (event.type === 'permission.required') return 'Permission required'
	if (event.type === 'permission.resolved') return 'Permission resolved'
	if (event.type === 'tool.started') return `Started ${event.call.name}`
	if (event.type === 'tool.finished') return `Finished ${event.callId.slice(0, 8)}`
	if (event.type === 'tool.failed') return `Failed ${event.callId.slice(0, 8)}`
	if (event.type === 'checkpoint.created') return 'Checkpoint'
	if (event.type === 'run.finished') return 'Run finished'
	if (event.type === 'run.failed') return 'Run failed'
	return event.type
}

const eventDetail = (event: AgentEvent) => {
	if (event.type === 'run.started') return event.goal
	if (event.type === 'model.delta') return event.text.trim()
	if (event.type === 'tool.requested') return safeStringify(event.call.input)
	if (event.type === 'permission.required') return event.decision.reason
	if (event.type === 'permission.resolved') return event.decision.reason
	if (event.type === 'tool.finished') return event.result.stderr ?? event.result.stdout ?? safeStringify(event.result.data ?? '')
	if (event.type === 'tool.failed') return event.error
	if (event.type === 'checkpoint.created') return event.checkpointId
	if (event.type === 'run.finished') return event.summary
	if (event.type === 'run.failed') return event.error
	return ''
}

const EventRow = ({ event }: { event: AgentEvent }) => {
	const detail = eventDetail(event)
	return <div className='border-b border-void-border-3/60 px-3 py-2'>
		<div className='flex items-center justify-between gap-2 text-xs'>
			<div className='font-medium text-void-fg-1 truncate'>{eventTitle(event)}</div>
			<div className='text-void-fg-3 shrink-0'>{event.type}</div>
		</div>
		{detail ? <div className='mt-1 max-h-24 overflow-hidden whitespace-pre-wrap break-words text-xs text-void-fg-3'>{detail}</div> : null}
	</div>
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

const candidateCommands = (candidate: CandidatePatch) => ({
	compare: `git diff --stat HEAD...${shellQuote(candidate.branchName)} && git diff HEAD...${shellQuote(candidate.branchName)}`,
	apply: `git diff --binary HEAD...${shellQuote(candidate.branchName)} | git apply -`,
	discard: `git worktree remove ${shellQuote(candidate.path)} && git branch -D ${shellQuote(candidate.branchName)}`,
})

const CopyCommandButton = ({ command, label, icon }: { command: string; label: string; icon: React.ReactNode }) => {
	const accessor = useAccessor()
	const clipboardService = accessor.get('IClipboardService')
	const [copied, setCopied] = useState(false)
	const onClick = useCallback(async () => {
		await clipboardService.writeText(command)
		setCopied(true)
		setTimeout(() => setCopied(false), 1200)
	}, [clipboardService, command])

	return <button
		type='button'
		className='inline-flex h-7 items-center gap-1 rounded border border-void-border-3 bg-void-bg-1 px-2 text-xs text-void-fg-2 hover:bg-void-bg-3 hover:text-void-fg-1'
		onClick={onClick}
		title={command}
	>
		{copied ? <Check size={13} /> : icon}
		<span>{copied ? 'Copied' : label}</span>
	</button>
}

const getCandidatePatches = (events: readonly AgentEvent[]): CandidatePatch[] => {
	const toolNameByCallId = new Map<string, string>()
	const candidates = new Map<string, CandidatePatch>()
	let latestCandidateId: string | null = null

	for (const event of events) {
		if (event.type === 'tool.requested' || event.type === 'tool.started') {
			toolNameByCallId.set(event.call.callId, event.call.name)
			continue
		}
		if (event.type !== 'tool.finished') continue

		const toolName = toolNameByCallId.get(event.callId)
		const data = event.result.data as any
		if (toolName === 'git_worktree_create' && data?.id && data?.path && data?.branchName) {
			const candidate = {
				id: String(data.id),
				path: String(data.path),
				branchName: String(data.branchName),
				createdAt: event.finishedAt,
			}
			candidates.set(candidate.id, candidate)
			latestCandidateId = candidate.id
		}
		if (toolName === 'subagent_review' && data?.result) {
			const targetId = latestCandidateId
			if (!targetId) continue
			const current = candidates.get(targetId)
			if (!current) continue
			candidates.set(targetId, { ...current, review: String(data.result).slice(0, 2000) })
		}
	}

	return [...candidates.values()].sort((a, b) => b.createdAt - a.createdAt)
}

const CandidatePatchPanel = ({ candidates }: { candidates: readonly CandidatePatch[] }) => {
	if (candidates.length === 0) return null

	return <div className='border-b border-void-border-3 bg-void-bg-2 px-3 py-2'>
		<div className='mb-2 text-xs font-medium text-void-fg-2'>Candidate Patches</div>
		<div className='flex flex-col gap-2'>
			{candidates.map(candidate => {
				const commands = candidateCommands(candidate)
				return <div key={candidate.id} className='rounded border border-void-border-3 bg-void-bg-1 p-2'>
					<div className='flex items-center justify-between gap-2'>
						<div className='min-w-0'>
							<div className='truncate text-xs font-medium text-void-fg-1'>{candidate.branchName}</div>
							<div className='truncate text-xs text-void-fg-3'>{candidate.path}</div>
						</div>
						<div className='shrink-0 rounded bg-void-bg-3 px-1.5 py-0.5 text-[10px] text-void-fg-3'>{candidate.id}</div>
					</div>
					<div className='mt-2 flex flex-wrap gap-1.5'>
						<CopyCommandButton command={commands.compare} label='Compare' icon={<GitCompare size={13} />} />
						<CopyCommandButton command={commands.apply} label='Apply' icon={<GitMerge size={13} />} />
						<CopyCommandButton command={commands.discard} label='Discard' icon={<Trash2 size={13} />} />
						<CopyCommandButton command={`cd ${shellQuote(candidate.path)}`} label='cd' icon={<Clipboard size={13} />} />
					</div>
					{candidate.review ? <div className='mt-2 max-h-28 overflow-hidden whitespace-pre-wrap break-words border-t border-void-border-3 pt-2 text-xs text-void-fg-3'>{candidate.review}</div> : null}
				</div>
			})}
		</div>
	</div>
}

const sessionLabel = (session: AgentSessionState) => {
	const lastRun = session.runs[session.runs.length - 1]
	return lastRun?.goal || session.sessionId
}

export const AgentTimeline = () => {
	const accessor = useAccessor()
	const timelineService = accessor.get('IAgentTimelineService')
	const { sessions } = useAgentTimelineState()
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)

	const selectedSession = useMemo(() => {
		return sessions.find(session => session.sessionId === selectedSessionId) ?? sessions[sessions.length - 1]
	}, [sessions, selectedSessionId])

	const events = selectedSession ? timelineService.getEvents(selectedSession.sessionId).slice().reverse() : []
	const chronologicalEvents = selectedSession ? timelineService.getEvents(selectedSession.sessionId) : []
	const candidates = useMemo(() => getCandidatePatches(chronologicalEvents), [chronologicalEvents])

	return <div className='flex h-full min-h-0 flex-col bg-void-bg-2 text-void-fg-1'>
		<div className='border-b border-void-border-3 px-3 py-2'>
			<div className='text-xs font-medium text-void-fg-2'>Agent Runs</div>
			<select
				className='mt-2 w-full rounded border border-void-border-3 bg-void-bg-1 px-2 py-1 text-xs text-void-fg-1 outline-none'
				value={selectedSession?.sessionId ?? ''}
				onChange={e => setSelectedSessionId(e.target.value)}
			>
				{sessions.length === 0 ? <option value=''>No runs yet</option> : null}
				{sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{sessionLabel(session)}</option>)}
			</select>
		</div>
		<CandidatePatchPanel candidates={candidates} />
		<div className='min-h-0 flex-1 overflow-y-auto'>
			{events.length === 0
				? <div className='px-3 py-4 text-xs text-void-fg-3'>No agent timeline events yet.</div>
				: events.map((event, i) => <EventRow key={`${event.type}-${event.runId}-${i}`} event={event} />)}
		</div>
	</div>
}

CREATE TABLE workspace_run_transcript (
 run_id TEXT NOT NULL REFERENCES workspace_runs(id),
 id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 200),
 sequence INTEGER NOT NULL CHECK(sequence>0),
 kind TEXT NOT NULL CHECK(kind IN ('message','reasoning','command_start','command_output','file_change','tool_call','tool_result','error','result','input_echo','system')),
 step_id TEXT CHECK(step_id IS NULL OR length(step_id) BETWEEN 1 AND 200),
 body TEXT NOT NULL CHECK(json_valid(body) AND json_type(body)='object' AND length(body)<=40000),
 truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1)),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(run_id,id),
 UNIQUE(run_id,sequence)
);
CREATE TRIGGER workspace_run_transcript_no_update BEFORE UPDATE ON workspace_run_transcript
BEGIN SELECT RAISE(ABORT,'Immutable workspace Run transcript'); END;
CREATE TRIGGER workspace_run_transcript_no_delete BEFORE DELETE ON workspace_run_transcript
BEGIN SELECT RAISE(ABORT,'Immutable workspace Run transcript'); END;

CREATE TABLE workspace_run_inputs (
 run_id TEXT NOT NULL REFERENCES workspace_runs(id),
 id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 200),
 request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
 sequence INTEGER NOT NULL CHECK(sequence>0),
 mode TEXT NOT NULL CHECK(mode IN ('guide','interrupt')),
 text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 4000),
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','delivered','applied','rejected')),
 reason TEXT CHECK(reason IS NULL OR length(reason)<=500),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(run_id,id),
 UNIQUE(run_id,sequence),
 UNIQUE(run_id,request_id)
);
CREATE INDEX workspace_run_inputs_updated ON workspace_run_inputs(run_id,updated_at);
CREATE TRIGGER workspace_run_inputs_forward BEFORE UPDATE ON workspace_run_inputs
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.id IS NOT OLD.id OR NEW.request_id IS NOT OLD.request_id OR NEW.sequence IS NOT OLD.sequence
 OR NEW.mode IS NOT OLD.mode OR NEW.text IS NOT OLD.text OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at<OLD.updated_at
 OR OLD.state IN ('applied','rejected')
 OR (OLD.state='delivered' AND NEW.state NOT IN ('delivered','applied','rejected'))
 OR (OLD.state='queued' AND NEW.state NOT IN ('queued','delivered','rejected'))
BEGIN SELECT RAISE(ABORT,'Workspace Run input state can only move forward'); END;
CREATE TRIGGER workspace_run_inputs_no_delete BEFORE DELETE ON workspace_run_inputs
BEGIN SELECT RAISE(ABORT,'Immutable workspace Run input'); END;

CREATE TABLE workspace_run_capabilities (
 run_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace_runs(id),
 runner TEXT NOT NULL CHECK(length(runner) BETWEEN 1 AND 64),
 guide INTEGER NOT NULL CHECK(guide IN (0,1)),
 interrupt INTEGER NOT NULL CHECK(interrupt IN (0,1)),
 note TEXT CHECK(note IS NULL OR length(note)<=500),
 updated_at INTEGER NOT NULL
);
CREATE TRIGGER workspace_run_capabilities_no_delete BEFORE DELETE ON workspace_run_capabilities
BEGIN SELECT RAISE(ABORT,'Immutable workspace Run capabilities'); END;

# Model-change history

The latest check compares FueliX's model list with the list the plugin already has. **No changes in this check**
means that comparison found no addition or removal. It does not mean the model list has never changed.

## Shared history

OpenChamber chats can use different directories. The plugin's model cache is shared across those locations. A chat
that starts after another chat refreshes the cache can begin with the new models already present.

The plugin keeps model-list observations in its shared OpenCode storage, then computes additions and removals from
consecutive distinct lists. An unchanged check does not add a change row. New chats and plugin reloads can read the
same history.

The status view projects that history using the current location's options. Models excluded by those options do not
appear as additions or removals there. The view distinguishes the full proxy-list count from eligible model counts.

## Dates and baseline

Each timestamp is when the plugin fetched the proxy list, or the fetch time recorded in a valid model cache. It is
not the time FueliX published an announcement. A cached observation can be recovered later; its original fetch time
keeps it in chronological order.

The first known list is a baseline. Its models are not labelled newly added. The plugin cannot establish when those
models first became available if it has no earlier observation.

Only successfully applied discoveries become observations. Empty or rejected responses, missing credentials, and
failed provider reloads do not create completed change rows.

## Retention and limits

Storage retains up to 200 model-list observations. The status report includes up to 50 history entries and marks
omitted older history explicitly. Every displayed change includes its complete added and removed model-ID lists.

History starts with the observations the plugin can record or recover from the shared cache. It does not reconstruct
an earlier timeline from announcements. A baseline containing a model does not prove its first-registration date.

Temporary storage failures are retried while the plugin runs. If storage keeps failing until the plugin restarts,
history can miss an observation. The latest check, current-run change record, and plugin warning remain the evidence;
the plugin does not invent a replacement timestamp.
The retry buffer holds up to 20 unwritten observations. A longer outage can drop the oldest buffered observation,
with a fixed warning in the plugin log.

The history stores no credentials, authentication headers, raw configuration, or arbitrary error messages. If an
observation contains a known key, the plugin does not save it. A history-storage failure does not stop discovery.

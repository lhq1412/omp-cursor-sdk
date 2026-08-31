function normalizeParamValue(value) {
	return value.trim().toLowerCase();
}

function getParameter(model, id) {
	return (model.parameters ?? []).find((parameter) => parameter.id === id);
}

function getDefaultParam(model, id) {
	const variant = (model.variants ?? []).find((candidate) => candidate.isDefault) ?? model.variants?.[0];
	return variant?.params?.find((param) => param.id === id)?.value;
}

function getContextValues(model) {
	const values = [];
	const usedValues = new Set();
	for (const { value } of getParameter(model, "context")?.values ?? []) {
		const normalized = normalizeParamValue(value);
		if (!normalized || usedValues.has(normalized)) continue;
		usedValues.add(normalized);
		values.push(value);
	}
	return values;
}

export function parseCursorContextWindowValue(value) {
	const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(value.trim());
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2]?.toLowerCase();
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	return Math.round(amount * (unit === "m" ? 1000000 : 1000));
}

function encodePiModelId(modelId, context) {
	return context ? `${modelId}@${context}` : modelId;
}

function getTwoTierContextPolicy(model, contextValues) {
	if (contextValues.length !== 2) return undefined;
	const parsed = contextValues.map((value) => ({
		value,
		contextWindow: parseCursorContextWindowValue(value),
	}));
	if (parsed.some(({ contextWindow }) => contextWindow === undefined)) return undefined;
	parsed.sort((a, b) => a.contextWindow - b.contextWindow);
	const standard = parsed[0];
	const extended = parsed[1];
	if (!standard || !extended || standard.contextWindow === extended.contextWindow) return undefined;
	return {
		standard: {
			value: standard.value,
			contextWindowKey: encodePiModelId(model.id, standard.value),
		},
		extended: {
			value: extended.value,
			contextWindowKey: encodePiModelId(model.id, extended.value),
		},
	};
}

export function getCursorModelSelectionIdentities(models) {
	const sortedModels = [...models].sort((a, b) => a.id.localeCompare(b.id));
	const usedPiModelIds = new Set();
	const identities = [];

	for (const model of sortedModels) {
		const contextValues = getContextValues(model);
		const defaultContext = getDefaultParam(model, "context");
		const contextTiers = getTwoTierContextPolicy(model, contextValues);
		const contexts = contextTiers
			? [undefined]
			: [
					undefined,
					...contextValues.filter(
						(value) => normalizeParamValue(value) !== normalizeParamValue(defaultContext ?? ""),
					),
				];

		for (const context of contexts) {
			const piModelId = encodePiModelId(model.id, context);
			if (usedPiModelIds.has(piModelId)) continue;
			usedPiModelIds.add(piModelId);
			const effectiveContext = context ?? contextTiers?.extended.value ?? defaultContext;
			identities.push({
				model,
				...(context ? { context } : {}),
				...(contextTiers ? { contextTiers } : {}),
				piModelId,
				contextWindowKey: encodePiModelId(model.id, effectiveContext),
			});
		}
	}

	return identities;
}

export function normalizeCursorContextWindowEntries(models, entries, source = "context windows") {
	const canonicalBySelectableId = new Map();
	for (const model of models) {
		for (const { piModelId, contextWindowKey } of getCursorModelSelectionIdentities([model])) {
			canonicalBySelectableId.set(piModelId, contextWindowKey);
			if (!canonicalBySelectableId.has(contextWindowKey)) {
				canonicalBySelectableId.set(contextWindowKey, contextWindowKey);
			}
		}
		for (const context of getContextValues(model)) {
			const contextWindowKey = encodePiModelId(model.id, context);
			if (!canonicalBySelectableId.has(contextWindowKey)) {
				canonicalBySelectableId.set(contextWindowKey, contextWindowKey);
			}
		}
	}
	const normalized = new Map();
	for (const [modelId, contextWindow] of entries) {
		const canonicalId = modelId === "default" ? modelId : canonicalBySelectableId.get(modelId);
		if (!canonicalId) continue;
		const existing = normalized.get(canonicalId);
		if (existing !== undefined && existing !== contextWindow) {
			throw new Error(`${source} assigns conflicting windows to equivalent selection ${canonicalId}: ${existing} and ${contextWindow}`);
		}
		normalized.set(canonicalId, contextWindow);
	}
	return normalized;
}

/**
 * Full-text search (FTS5) BM25 ranking supervisor and snippet synthesizer.
 *
 * Implements prefix tokenization, inverse document frequency (IDF) calculation,
 * Okapi BM25 field-weighted relevance scoring, and snippet generation for
 * workflow run events and state ledgers (A1, A4).
 */

export interface FtsDocument {
  readonly docId: string
  readonly runId: string
  readonly eventType: string
  readonly title: string
  readonly body: string
  readonly timestamp: number
  readonly tokensCount: number
}

export interface FtsSearchMatch {
  readonly docId: string
  readonly runId: string
  readonly eventType: string
  readonly score: number
  readonly titleSnippet: string
  readonly bodySnippet: string
  readonly matchedTerms: readonly string[]
}

export interface FtsSearchResult {
  readonly query: string
  readonly totalMatches: number
  readonly matches: readonly FtsSearchMatch[]
  readonly executionDurationMs: number
}

export interface FtsRankerConfig {
  /** BM25 term frequency saturation parameter. Defaults to 1.2. */
  readonly k1?: number | undefined
  /** BM25 document length normalization parameter. Defaults to 0.75. */
  readonly b?: number | undefined
  /** Multiplier for title field matches. Defaults to 2.0. */
  readonly titleWeight?: number | undefined
  /** Multiplier for body field matches. Defaults to 1.0. */
  readonly bodyWeight?: number | undefined
  /** Character context radius surrounding matched terms in snippets. Defaults to 30. */
  readonly snippetRadiusChars?: number | undefined
}

interface InternalDocRecord {
  readonly doc: FtsDocument
  readonly titleTokens: readonly string[]
  readonly bodyTokens: readonly string[]
  readonly titleTermFreqs: Map<string, number>
  readonly bodyTermFreqs: Map<string, number>
}

export class SqliteFts5SearchRankerSupervisor {
  private readonly k1: number
  private readonly b: number
  private readonly titleWeight: number
  private readonly bodyWeight: number
  private readonly snippetRadiusChars: number

  private readonly documents = new Map<string, InternalDocRecord>()
  // term -> Set of docIds that contain this term (in title or body)
  private readonly invertedIndex = new Map<string, Set<string>>()

  constructor(config: FtsRankerConfig = {}) {
    this.k1 = config.k1 ?? 1.2
    this.b = config.b ?? 0.75
    this.titleWeight = config.titleWeight ?? 2.0
    this.bodyWeight = config.bodyWeight ?? 1.0
    this.snippetRadiusChars = Math.max(10, config.snippetRadiusChars ?? 30)
  }

  /**
   * Tokenizes arbitrary text into lowercase words.
   */
  tokenize(text: string): string[] {
    const matches = text.toLowerCase().match(/[a-z0-9_-]+/g)
    return matches ? Array.from(matches) : []
  }

  /**
   * Ingests and indexes a document for full-text search.
   */
  indexDocument(doc: {
    readonly docId: string
    readonly runId: string
    readonly eventType: string
    readonly title: string
    readonly body: string
    readonly timestamp?: number | undefined
  }): FtsDocument {
    if (!doc.docId || doc.docId.trim().length === 0) {
      throw new Error('docId cannot be empty')
    }

    // Remove existing doc if re-indexing
    if (this.documents.has(doc.docId)) {
      this.removeDocument(doc.docId)
    }

    const titleTokens = this.tokenize(doc.title)
    const bodyTokens = this.tokenize(doc.body)
    const totalTokens = titleTokens.length + bodyTokens.length

    const titleTermFreqs = new Map<string, number>()
    for (const t of titleTokens) {
      titleTermFreqs.set(t, (titleTermFreqs.get(t) ?? 0) + 1)
    }

    const bodyTermFreqs = new Map<string, number>()
    for (const t of bodyTokens) {
      bodyTermFreqs.set(t, (bodyTermFreqs.get(t) ?? 0) + 1)
    }

    const ftsDoc: FtsDocument = {
      docId: doc.docId,
      runId: doc.runId,
      eventType: doc.eventType,
      title: doc.title,
      body: doc.body,
      timestamp: doc.timestamp ?? Date.now(),
      tokensCount: totalTokens,
    }

    const record: InternalDocRecord = {
      doc: ftsDoc,
      titleTokens,
      bodyTokens,
      titleTermFreqs,
      bodyTermFreqs,
    }

    this.documents.set(doc.docId, record)

    // Update inverted index
    const allDocTerms = new Set([...titleTermFreqs.keys(), ...bodyTermFreqs.keys()])
    for (const term of allDocTerms) {
      let docSet = this.invertedIndex.get(term)
      if (!docSet) {
        docSet = new Set()
        this.invertedIndex.set(term, docSet)
      }
      docSet.add(doc.docId)
    }

    return ftsDoc
  }

  /**
   * Removes a document from the index.
   */
  removeDocument(docId: string): boolean {
    const record = this.documents.get(docId)
    if (!record) return false

    const allTerms = new Set([...record.titleTermFreqs.keys(), ...record.bodyTermFreqs.keys()])
    for (const term of allTerms) {
      const docSet = this.invertedIndex.get(term)
      if (docSet) {
        docSet.delete(docId)
        if (docSet.size === 0) {
          this.invertedIndex.delete(term)
        }
      }
    }

    this.documents.delete(docId)
    return true
  }

  /**
   * Retrieves an indexed document by ID.
   */
  getDocument(docId: string): FtsDocument | undefined {
    return this.documents.get(docId)?.doc
  }

  /**
   * Total number of indexed documents.
   */
  getDocumentCount(): number {
    return this.documents.size
  }

  /**
   * Clears all indexed documents.
   */
  clear(): void {
    this.documents.clear()
    this.invertedIndex.clear()
  }

  /**
   * Performs an Okapi BM25 scored search with prefix expansion and snippet formatting.
   */
  search(
    rawQuery: string,
    options: {
      readonly limit?: number | undefined
      readonly runId?: string | undefined
      readonly eventType?: string | undefined
    } = {},
  ): FtsSearchResult {
    const startTime = Date.now()
    const limit = Math.max(1, options.limit ?? 20)
    const rawTokens = this.tokenize(rawQuery)

    if (rawTokens.length === 0 || this.documents.size === 0) {
      return {
        query: rawQuery,
        totalMatches: 0,
        matches: [],
        executionDurationMs: Date.now() - startTime,
      }
    }

    const N = this.documents.size
    let sumTitleLength = 0
    let sumBodyLength = 0
    for (const record of this.documents.values()) {
      sumTitleLength += record.titleTokens.length
      sumBodyLength += record.bodyTokens.length
    }
    const avgdlTitle = Math.max(1, sumTitleLength / N)
    const avgdlBody = Math.max(1, sumBodyLength / N)

    // Expand query tokens (supporting prefix matching if token in rawQuery ended with '*')
    const queryParts = rawQuery.trim().split(/\s+/)
    const expandedTerms = new Map<string, string[]>() // queryToken -> matching index terms

    for (const part of queryParts) {
      const isPrefix = part.endsWith('*')
      const cleanTerm = part.replace(/\*/g, '').toLowerCase()
      if (!cleanTerm) continue

      if (isPrefix) {
        const matches: string[] = []
        for (const indexTerm of this.invertedIndex.keys()) {
          if (indexTerm.startsWith(cleanTerm)) {
            matches.push(indexTerm)
          }
        }
        expandedTerms.set(part, matches)
      } else {
        if (this.invertedIndex.has(cleanTerm)) {
          expandedTerms.set(part, [cleanTerm])
        }
      }
    }

    // Accumulate BM25 scores per document
    const docScores = new Map<string, number>()
    const docMatchedTerms = new Map<string, Set<string>>()

    for (const terms of expandedTerms.values()) {
      for (const term of terms) {
        const postingDocs = this.invertedIndex.get(term)
        if (!postingDocs || postingDocs.size === 0) continue

        const n_q = postingDocs.size
        // Standard BM25 IDF
        const idf = Math.log(1 + (N - n_q + 0.5) / (n_q + 0.5))

        for (const docId of postingDocs) {
          const record = this.documents.get(docId)
          if (!record) continue

          // Filters
          if (options.runId && record.doc.runId !== options.runId) continue
          if (options.eventType && record.doc.eventType !== options.eventType) continue

          const freqTitle = record.titleTermFreqs.get(term) ?? 0
          const freqBody = record.bodyTermFreqs.get(term) ?? 0

          const scoreTitle =
            freqTitle > 0
              ? (freqTitle * (this.k1 + 1)) /
                (freqTitle +
                  this.k1 * (1 - this.b + this.b * (record.titleTokens.length / avgdlTitle)))
              : 0

          const scoreBody =
            freqBody > 0
              ? (freqBody * (this.k1 + 1)) /
                (freqBody +
                  this.k1 * (1 - this.b + this.b * (record.bodyTokens.length / avgdlBody)))
              : 0

          const termScore = idf * (this.titleWeight * scoreTitle + this.bodyWeight * scoreBody)
          docScores.set(docId, (docScores.get(docId) ?? 0) + termScore)

          let termSet = docMatchedTerms.get(docId)
          if (!termSet) {
            termSet = new Set()
            docMatchedTerms.set(docId, termSet)
          }
          termSet.add(term)
        }
      }
    }

    // Sort descending by score
    const sortedDocEntries = Array.from(docScores.entries())
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1])

    const totalMatches = sortedDocEntries.length
    const pagedMatches = sortedDocEntries.slice(0, limit)

    const matches: FtsSearchMatch[] = []
    for (const [docId, score] of pagedMatches) {
      const record = this.documents.get(docId)
      if (!record) continue

      const matchedTermsList = Array.from(docMatchedTerms.get(docId) ?? [])
      const titleSnippet = this.generateSnippet(record.doc.title, matchedTermsList)
      const bodySnippet = this.generateSnippet(record.doc.body, matchedTermsList)

      matches.push({
        docId,
        runId: record.doc.runId,
        eventType: record.doc.eventType,
        score: Math.round(score * 1000) / 1000,
        titleSnippet,
        bodySnippet,
        matchedTerms: matchedTermsList,
      })
    }

    return {
      query: rawQuery,
      totalMatches,
      matches,
      executionDurationMs: Date.now() - startTime,
    }
  }

  /**
   * Generates a snippet highlighting matched terms with <mark> tags.
   */
  private generateSnippet(text: string, matchedTerms: readonly string[]): string {
    if (!text || matchedTerms.length === 0) {
      return text
    }

    const lowerText = text.toLowerCase()
    let earliestPos = -1

    for (const term of matchedTerms) {
      const pos = lowerText.indexOf(term.toLowerCase())
      if (pos >= 0 && (earliestPos === -1 || pos < earliestPos)) {
        earliestPos = pos
      }
    }

    if (earliestPos === -1) {
      return text.length > this.snippetRadiusChars * 2
        ? `${text.slice(0, this.snippetRadiusChars * 2)}...`
        : text
    }

    const start = Math.max(0, earliestPos - this.snippetRadiusChars)
    const end = Math.min(text.length, earliestPos + this.snippetRadiusChars * 2)

    let snippet = text.slice(start, end)
    if (start > 0) snippet = `...${snippet}`
    if (end < text.length) snippet = `${snippet}...`

    // Highlight terms
    for (const term of matchedTerms) {
      const regex = new RegExp(`(${term})`, 'gi')
      snippet = snippet.replace(regex, '<mark>$1</mark>')
    }

    return snippet
  }
}

/**
 * CUDA graph side streams: a graph that forks during capture runs those branches on
 * internal streams of its own, so a trace with many graphs shows hundreds of streams
 * holding a few kernels each. Rows are (deviceId, side streamId, launch streamId).
 *
 * A side stream runs only graph kernels, all from graphs launched on one other stream.
 * Kernel records do not name a graph's launch stream, so it is taken to be the stream
 * holding most of the graph's kernels, preferring streams that also run eager kernels.
 */
export const GRAPH_SIDE_STREAMS_SQL = `
  WITH counts AS (
    SELECT deviceId, graphId, streamId, COUNT(*) AS n
    FROM CUPTI_ACTIVITY_KIND_KERNEL WHERE graphId IS NOT NULL GROUP BY 1, 2, 3
  ), eager AS (
    SELECT DISTINCT deviceId, streamId FROM CUPTI_ACTIVITY_KIND_KERNEL WHERE graphId IS NULL
  ), launches AS (
    SELECT deviceId, graphId, streamId FROM (
      SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.deviceId, c.graphId
        ORDER BY e.streamId IS NOT NULL DESC, c.n DESC, c.streamId) AS rank
      FROM counts AS c LEFT JOIN eager AS e USING (deviceId, streamId))
    WHERE rank = 1
  )
  SELECT c.deviceId, c.streamId, MIN(l.streamId)
  FROM counts AS c JOIN launches AS l USING (deviceId, graphId)
  WHERE (c.deviceId, c.streamId) NOT IN (SELECT * FROM eager)
  GROUP BY 1, 2
  HAVING COUNT(DISTINCT l.streamId) = 1 AND MIN(l.streamId) != c.streamId
`;

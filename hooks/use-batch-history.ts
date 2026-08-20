'use client';

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BatchResult } from '@/lib/stellar/types';
import { fetchBatchHistory, setCachedHistory, clearCachedHistory } from '@/lib/batch-history-adapter';
import { batchHistoryKeys } from '@/lib/query-keys';
import { useOptionalWalletSession } from '@/contexts/WalletSessionContext';

export function useBatchHistory(publicKey?: string | null) {
  const queryClient = useQueryClient();
  const walletSession = useOptionalWalletSession();
  const sessionToken = walletSession?.sessionToken ?? null;
  // Central key factory (#521): this account's parent batch-history key.
  const queryKey = batchHistoryKeys.all(publicKey);

  const { data: history = [], isLoading, error } = useQuery({
    queryKey,
    queryFn: async () => {
      const items = await fetchBatchHistory(publicKey!, { limit: 50 });
      setCachedHistory(items);
      return items;
    },
    enabled: !!publicKey && !!sessionToken,
    staleTime: 30 * 1000,
    placeholderData: (previousData) => previousData ?? [],
  });

  const saveResult = useCallback((result: BatchResult) => {
    queryClient.setQueryData<BatchResult[]>(queryKey, (prev = []) => {
      const newHistory = [result, ...prev].slice(0, 50);
      setCachedHistory(newHistory);
      return newHistory;
    });
  }, [queryClient, queryKey]);

  const getLatestResult = useCallback((): BatchResult | null => {
    return history[0] || null;
  }, [history]);

  const clearHistory = useCallback(() => {
    clearCachedHistory();
    queryClient.setQueryData<BatchResult[]>(queryKey, []);
  }, [queryClient, queryKey]);

  const refresh = useCallback(() => {
    return queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    history,
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : 'Failed to load history') : null,
    saveResult,
    getLatestResult,
    clearHistory,
    refresh,
  };
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MutationKeys,
  QueryKeys,
  dataService,
  type FeelingBandId,
  type FeelingsResponse,
  type UpdateFeelingBand,
  type UpdateFeelingsProfile,
} from 'librechat-data-provider';

const feelingsKey = [QueryKeys.feelings];

export const useFeelingsQuery = () =>
  useQuery<FeelingsResponse>(feelingsKey, () => dataService.getFeelings(), {
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: (data) => (data?.state.reactionHealth.status === 'running' ? 750 : 2500),
  });

function useFeelingsMutation<TVariables>(
  mutationKey: MutationKeys,
  mutationFn: (variables: TVariables) => Promise<FeelingsResponse>,
) {
  const queryClient = useQueryClient();
  return useMutation<FeelingsResponse, Error, TVariables>([mutationKey], mutationFn, {
    onSuccess: (response) => queryClient.setQueryData(feelingsKey, response),
    onError: () => queryClient.invalidateQueries(feelingsKey),
  });
}

export const useUpdateFeelingsProfileMutation = () =>
  useFeelingsMutation(MutationKeys.updateFeelingsProfile, dataService.updateFeelingsProfile);

export const useUpdateFeelingBandMutation = () =>
  useFeelingsMutation<{
    bandId: FeelingBandId;
    data: UpdateFeelingBand;
  }>(MutationKeys.updateFeelingBand, dataService.updateFeelingBand);

export const useResetFeelingsMutation = () =>
  useFeelingsMutation<number>(MutationKeys.resetFeelings, dataService.resetFeelings);

export const useDeleteFeelingsMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<{ deleted: boolean }, Error, number>(
    [MutationKeys.deleteFeelings],
    dataService.deleteFeelings,
    {
      onSuccess: () => queryClient.invalidateQueries(feelingsKey),
    },
  );
};

export type { UpdateFeelingBand, UpdateFeelingsProfile };

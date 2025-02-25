import {ChainId, Currency, CurrencyAmount, Price, WNATIVE, WETH9, TradeType, ERC20Token} from '@pancakeswap/sdk'
import { STABLE_COIN, ICE } from '@pancakeswap/tokens'
import { useMemo } from 'react'
import useSWRImmutable from 'swr/immutable'
import { multiplyPriceByAmount } from 'utils/prices'
import { useCakePrice } from 'hooks/useCakePrice'
import { getFullDecimalMultiplier } from '@pancakeswap/utils/getFullDecimalMultiplier'
import { computeTradePriceBreakdown } from 'views/Swap/V3Swap/utils/exchange'
import { warningSeverity } from 'utils/exchange'
import { PairState, useV2Pairs } from './usePairs'
import { useActiveChainId } from './useActiveChainId'
import { useBestAMMTrade } from './useBestAMMTrade'

type UseStablecoinPriceConfig = {
  enabled?: boolean
  hideIfPriceImpactTooHigh?: boolean
}
const DEFAULT_CONFIG: UseStablecoinPriceConfig = {
  enabled: true,
  hideIfPriceImpactTooHigh: false,
}

export function useStablecoinPrice(
  currency?: Currency,
  config: UseStablecoinPriceConfig = DEFAULT_CONFIG,
): Price<Currency, Currency> | undefined {
  const { chainId: currentChainId } = useActiveChainId()
  const chainId = currency?.chainId
  const { enabled, hideIfPriceImpactTooHigh } = { ...DEFAULT_CONFIG, ...config }

  const cakePrice = useCakePrice()
  const stableCoin = chainId in ChainId ? STABLE_COIN[chainId as ChainId] : undefined
  const isCake = currency && ICE[chainId] && currency.wrapped.equals(ICE[chainId])

  const isStableCoin = currency && stableCoin && currency.wrapped.equals(stableCoin)

  const shouldEnabled = currency && enabled && currentChainId === chainId // currency && stableCoin && enabled && currentChainId === chainId && !isCake && !isStableCoin

  const enableLlama = shouldEnabled // currency?.chainId === ChainId.ETHEREUM && shouldEnabled

  // using IceCreamSwap token prices API
  const { data: priceFromLlama, isLoading } = useSWRImmutable<string>(
    currency && enableLlama && ['fiat-price-ethereum', currency],
    async () => {
      const address = currency?.isToken ? currency.address : WETH9[chainId].address
      return fetch(`https://pricing.icecreamswap.com/${chainId}?token=${address}`)
        .then((res) => res.json())
        .then(
          (res) => res?.[`${address}`],
        )
        .catch(reason => {
          console.warn("Error while getting token price", reason)
          return null
        })
    },
    {
      dedupingInterval: 30_000,
      refreshInterval: 30_000,
    },
  )

  const amountOut = useMemo(
    () => (stableCoin && CurrencyAmount.fromRawAmount(stableCoin, 5 * 10 ** stableCoin.decimals)),
    [stableCoin],
  )

  const { trade } = useBestAMMTrade({
    amount: amountOut,
    currency,
    baseCurrency: stableCoin,
    tradeType: TradeType.EXACT_OUTPUT,
    maxSplits: 0,
    enabled: enableLlama ? !isLoading && !priceFromLlama : shouldEnabled,
    autoRevalidate: false,
    type: 'api',
  })

  const price = useMemo(() => {
    if (!currency || !enabled) {
      return undefined
    }

    if (priceFromLlama && enableLlama) {
      return new Price(
        currency,
        stableCoin || new ERC20Token(
          currency.chainId,
          "0x0000000000000000000000000000000000000000",
          18,
          "Null"
        ),
        10 ** currency.decimals,
        getFullDecimalMultiplier(stableCoin?.decimals || 18)
          .times(parseFloat(priceFromLlama).toFixed(stableCoin?.decimals || 18))
          .toString(),
      )
    }

    if (!stableCoin) {
      return undefined
    }

    if (isCake && cakePrice) {
      return new Price(
        currency,
        stableCoin,
        10 ** currency.decimals,
        getFullDecimalMultiplier(stableCoin.decimals).times(cakePrice.toFixed(stableCoin.decimals)).toString(),
      )
    }

    // handle stable coin
    if (isStableCoin) {
      return new Price(stableCoin, stableCoin, '1', '1')
    }

    if (trade) {
      const { inputAmount, outputAmount } = trade

      // if price impact is too high, don't show price
      if (hideIfPriceImpactTooHigh) {
        const { priceImpactWithoutFee } = computeTradePriceBreakdown(trade)

        if (!priceImpactWithoutFee || warningSeverity(priceImpactWithoutFee) > 2) {
          return undefined
        }
      }

      return new Price(currency, stableCoin, inputAmount.quotient, outputAmount.quotient)
    }

    return undefined
  }, [
    currency,
    stableCoin,
    enabled,
    isCake,
    cakePrice,
    isStableCoin,
    priceFromLlama,
    enableLlama,
    trade,
    hideIfPriceImpactTooHigh,
  ])

  return price
}

/**
 * Returns the price in BUSD of the input currency
 * @param currency currency to compute the BUSD price of
 * @deprecated it's using v2 pair
 */
export default function useBUSDPrice(currency?: Currency): Price<Currency, Currency> | undefined {
  const { chainId } = useActiveChainId()
  const wrapped = currency?.wrapped
  const wnative = WNATIVE[chainId]
  const stable = STABLE_COIN[chainId]

  const tokenPairs: [Currency | undefined, Currency | undefined][] = useMemo(
    () => [
      [chainId && wrapped && wnative?.equals(wrapped) ? undefined : currency, chainId ? wnative : undefined],
      [stable && wrapped?.equals(stable) ? undefined : wrapped, stable],
      [chainId ? wnative : undefined, stable],
    ],
    [wnative, stable, chainId, currency, wrapped],
  )
  const [[bnbPairState, bnbPair], [busdPairState, busdPair], [busdBnbPairState, busdBnbPair]] = useV2Pairs(tokenPairs)

  return useMemo(() => {
    if (!currency || !wrapped || !chainId || !wnative) {
      return undefined
    }

    // handle busd
    if (wrapped.equals(stable)) {
      return new Price(stable, stable, '1', '1')
    }

    const isBUSDPairExist =
      busdPair &&
      busdPairState === PairState.EXISTS &&
      busdPair.reserve0.greaterThan('0') &&
      busdPair.reserve1.greaterThan('0')

    // handle wbnb/bnb
    if (wrapped.equals(wnative)) {
      if (isBUSDPairExist) {
        const price = busdPair.priceOf(wnative)
        return new Price(currency, stable, price.denominator, price.numerator)
      }
      return undefined
    }

    const isBnbPairExist =
      bnbPair &&
      bnbPairState === PairState.EXISTS &&
      bnbPair.reserve0.greaterThan('0') &&
      bnbPair.reserve1.greaterThan('0')
    const isBusdBnbPairExist =
      busdBnbPair &&
      busdBnbPairState === PairState.EXISTS &&
      busdBnbPair.reserve0.greaterThan('0') &&
      busdBnbPair.reserve1.greaterThan('0')

    const bnbPairBNBAmount = isBnbPairExist && bnbPair?.reserveOf(wnative)
    const bnbPairBNBBUSDValue: bigint =
      bnbPairBNBAmount && isBUSDPairExist && isBusdBnbPairExist
        ? busdBnbPair.priceOf(wnative).quote(bnbPairBNBAmount).quotient
        : 0n

    // all other tokens
    // first try the busd pair
    if (isBUSDPairExist && busdPair.reserveOf(stable).greaterThan(bnbPairBNBBUSDValue)) {
      const price = busdPair.priceOf(wrapped)
      return new Price(currency, stable, price.denominator, price.numerator)
    }
    if (isBnbPairExist && isBusdBnbPairExist) {
      if (busdBnbPair.reserveOf(stable).greaterThan('0') && bnbPair.reserveOf(wnative).greaterThan('0')) {
        const bnbBusdPrice = busdBnbPair.priceOf(stable)
        const currencyBnbPrice = bnbPair.priceOf(wnative)
        const busdPrice = bnbBusdPrice.multiply(currencyBnbPrice).invert()
        return new Price(currency, stable, busdPrice.denominator, busdPrice.numerator)
      }
    }

    return undefined
  }, [
    currency,
    wrapped,
    chainId,
    wnative,
    stable,
    bnbPair,
    busdBnbPair,
    busdPairState,
    busdPair,
    bnbPairState,
    busdBnbPairState,
  ])
}

export const useStablecoinPriceAmount = (
  currency?: Currency,
  amount?: number,
  config?: UseStablecoinPriceConfig,
): number | undefined => {
  const stablePrice = useStablecoinPrice(currency, { enabled: !!currency, ...config })

  if (amount) {
    if (stablePrice) {
      return multiplyPriceByAmount(stablePrice, amount)
    }
  }
  return undefined
}

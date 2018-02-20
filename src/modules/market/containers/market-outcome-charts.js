import { connect } from 'react-redux'
import memoize from 'memoizee'

import MarketOutcomeCharts from 'modules/market/components/market-outcome-charts/market-outcome-charts'

import { BIDS, ASKS } from 'modules/order-book/constants/order-book-order-types'

import { selectMarket } from 'modules/market/selectors/market'
import { isEmpty } from 'lodash'

const startTime = new Date().getTime()

const marketPriceHistory = [...new Array(30)]
  .map((value, index) => ({
    period: startTime + (index * ((1000000000000 - 0) + 0)),
    high: (Math.random()),
    low: (Math.random()),
    open: (Math.random()),
    close: (Math.random()),
    volume: (Math.random() * (1000 - 10)) + 10
  }))
  .sort((a, b) => a.x - b.x)

// outcome specific trading price range
const findBounds = memoize((outcome = {}) => {
  const DEFAULT_BOUNDS = {
    min: null,
    max: null
  }

  if (isEmpty(outcome)) return DEFAULT_BOUNDS

  return (outcome.priceTimeSeries || []).reduce((p, item, i) => {
    const currentItem = item[1]

    if (i === 0) {
      return {
        min: currentItem,
        max: currentItem
      }
    }

    return {
      min: currentItem < p.min ? currentItem : p.min,
      max: currentItem > p.max ? currentItem : p.max
    }
  }, DEFAULT_BOUNDS)
})

const orderAndAssignCumulativeShares = memoize((orderBook) => {
  const rawBids = (orderBook[BIDS] || []).slice()
  const bids = rawBids
    .sort((a, b) => b.price.value - a.price.value)
    .reduce((p, order, i, orders) => [
      ...p,
      {
        price: order.price,
        shares: order.shares,
        cumulativeShares: p[i - 1] != null ? p[i - 1].cumulativeShares + order.shares.value : 0
      }
    ], [])

  const rawAsks = (orderBook[ASKS] || []).slice()
  const asks = rawAsks
    .sort((a, b) => a.price.value - b.price.value)
    .reduce((p, order, i, orders) => [
      ...p,
      {
        price: order.price,
        shares: order.shares,
        cumulativeShares: p[i - 1] != null ? p[i - 1].cumulativeShares + order.shares.value : 0
      }
    ], [])
    .sort((a, b) => b.price.value - a.price.value)

  return {
    bids,
    asks
  }
})

const orderForMarketDepth = memoize((orderBook) => {
  const rawBids = (orderBook[BIDS] || []).slice()
  const bids = rawBids
    .reduce((p, order) => [...p, [order.cumulativeShares, order.price.value, order.shares.value]], [])
  const rawAsks = (orderBook[ASKS] || []).slice()
  const asks = rawAsks
    .sort((a, b) => a.price.value - b.price.value)
    .reduce((p, order) => [...p, [order.cumulativeShares, order.price.value, order.shares.value]], [])

  return {
    [BIDS]: bids,
    [ASKS]: asks
  }
})

const getOrderBookKeys = memoize((marketDepth) => {
  const min = marketDepth[BIDS].reduce((p, order, i) => {
    if (i === 0) return order[1]
    return order[1] < p ? order[1] : p
  }, null)

  const mid = () => {
    if (marketDepth[ASKS].length === 0 && marketDepth[BIDS].length === 0) {
      return null
    } else if (marketDepth[ASKS].length === 0 && marketDepth[BIDS].length > 0) {
      return marketDepth[BIDS][0][1]
    } else if (marketDepth[ASKS].length > 0 && marketDepth[BIDS].length === 0) {
      return marketDepth[ASKS][0][1]
    }

    return (marketDepth[ASKS][0][1] + marketDepth[BIDS][0][1]) / 2
  }

  const max = marketDepth[BIDS].reduce((p, order, i) => {
    if (i === 0) return order[1]
    return order[1] > p ? order[1] : p
  }, null)

  return {
    min,
    mid: mid(),
    max
  }
})

const mapStateToProps = (state, ownProps) => {
  const market = selectMarket(ownProps.marketId)
  const outcome = market.outcomes.find(outcome => outcome.id === ownProps.selectedOutcome) || {}
  const cumulativeOrderBook = orderAndAssignCumulativeShares(outcome.orderBook)
  const marketDepth = orderForMarketDepth(cumulativeOrderBook)
  const orderBookKeys = getOrderBookKeys(marketDepth)

  return {
    marketPriceHistory,
    minPrice: market.minPrice,
    maxPrice: market.maxPrice,
    outcomeBounds: findBounds(outcome),
    orderBook: cumulativeOrderBook,
    marketDepth,
    orderBookKeys
  }
}

export default connect(mapStateToProps)(MarketOutcomeCharts)

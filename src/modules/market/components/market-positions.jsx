import React, { Component } from 'react';

import Positions from 'modules/my-positions/components/my-positions';
import MarketPositionsRow from 'modules/market/components/market-positions-row';

import getValue from 'utils/get-value';

export default class MarketPositions extends Component {
	constructor(props) {
		super(props);
	}

	render() {
		const p = this.props;

		const outcomePositions = getValue(p, 'market.myPositionOutcomes');
		const marketType = getValue(p, 'market.type');

		return (
			<article className="market-positions">
				<div className="market-positions-header">
					<span>Outcomes</span>
					<span>Shares</span>
					<span>Avg Price</span>
					<span>Last Price</span>
					<span>Realized P/L</span>
					<span>Unrealized P/L</span>
					<span>Total P/L</span>
				</div>
				{(outcomePositions || []).map(outcome =>
					<MarketPositionsRow
						key={outcome.id}
						type={marketType}
						outcome={outcome}
					/>
				)}
			</article>
		);
	}
}
